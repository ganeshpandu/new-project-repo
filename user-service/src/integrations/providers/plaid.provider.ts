import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationProviderName, ConnectResponse, CallbackPayload } from '../types';
import { IntegrationPersistence } from '../persistence';
import { PrismaService } from '@traeta/prisma';
import { TokenStore } from '../token-store';
import { PlaidApi, Configuration, PlaidEnvironments, LinkTokenCreateRequest, ItemPublicTokenExchangeRequest, TransactionsGetRequest, AccountsGetRequest, InstitutionsGetByIdRequest, Products, CountryCode, Transaction } from 'plaid';
import {
    ConfigurationException,
    InvalidCallbackException,
    OAuthAuthenticationException,
    InvalidTokenException,
    DataSyncException,
    ProviderAPIException,
    RateLimitException,
} from '../exceptions/integration.exceptions';
import { DATA_TYPE, REC_SEQ, STATUS } from '../../../constants';

interface PlaidAccount {
    account_id: string;
    balances: {
        available: number | null;
        current: number | null;
        iso_currency_code: string | null;
        limit: number | null;
        unofficial_currency_code: string | null;
    };
    mask: string | null;
    name: string;
    official_name: string | null;
    subtype: string | null;
    type: string;
}

interface PlaidTransaction {
    account_id: string;
    amount: number;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
    category: string[] | null;
    category_id: string | null;
    date: string;
    datetime: string | null;
    authorized_date: string | null;
    authorized_datetime: string | null;
    location: {
        address: string | null;
        city: string | null;
        region: string | null;
        postal_code: string | null;
        country: string | null;
        lat: number | null;
        lon: number | null;
        store_number: string | null;
    } | null;
    name: string;
    merchant_name: string | null;
    payment_meta: {
        by_order_of: string | null;
        payee: string | null;
        payer: string | null;
        payment_method: string | null;
        payment_processor: string | null;
        ppd_id: string | null;
        reason: string | null;
        reference_number: string | null;
    } | null;
    payment_channel: string;
    pending: boolean;
    pending_transaction_id: string | null;
    account_owner: string | null;
    transaction_id: string;
    transaction_code: string | null;
    transaction_type: string | null;
}

@Injectable()
export class PlaidProvider implements IntegrationProvider {
    public readonly name = IntegrationProviderName.PLAID;
    private readonly logger = new Logger(PlaidProvider.name);

    constructor(
        private readonly db: PrismaService,
        private readonly persistence: IntegrationPersistence,
        private readonly tokens: TokenStore,
        private readonly configService: ConfigService,
    ) { }

    private getClientId(): string {
        return this.configService.get<string>('PLAID_CLIENT_ID') || '';
    }

    private getSecret(): string {
        return this.configService.get<string>('PLAID_SECRET') || '';
    }

    private getEnvironment(): string {
        return this.configService.get<string>('PLAID_ENV') || 'sandbox';
    }

    private getPlaidClient(): PlaidApi {
        const configuration = new Configuration({
            basePath: this.getPlaidEnvironment(),
            baseOptions: {
                headers: {
                    'PLAID-CLIENT-ID': this.getClientId(),
                    'PLAID-SECRET': this.getSecret(),
                },
            },
        });
        return new PlaidApi(configuration);
    }

    private getPlaidEnvironment(): string {
        switch (this.getEnvironment()) {
            case 'sandbox':
                return PlaidEnvironments.sandbox;
            case 'development':
                return PlaidEnvironments.development;
            case 'production':
                return PlaidEnvironments.production;
            default:
                return PlaidEnvironments.sandbox;
        }
    }

    async createConnection(userId: string): Promise<ConnectResponse> {
        this.logger.log(`Creating Plaid link token for user ${userId}`);

        // Validate configuration
        const clientId = this.getClientId();
        const secret = this.getSecret();
        if (!clientId || !secret) {
            throw new ConfigurationException(
                IntegrationProviderName.PLAID,
                'Plaid integration is not properly configured. Missing CLIENT_ID or SECRET.'
            );
        }

        try {
            const state = `plaid-${userId}-${Date.now()}`;

            const request: LinkTokenCreateRequest = {
                user: {
                    client_user_id: userId,
                },
                client_name: 'Traeta',
                products: [Products.Transactions],
                country_codes: [CountryCode.Us],
                language: 'en',
                webhook: process.env.PLAID_WEBHOOK_URL,
                redirect_uri: process.env.PLAID_REDIRECT_URI,
            };

            const response = await this.getPlaidClient().linkTokenCreate(request);
            const linkToken = response.data.link_token;

            await this.persistence.ensureIntegration('plaid');

            return {
                provider: this.name,
                linkToken,
                state,
                redirectUrl: `plaid://link?token=${linkToken}` // For mobile deep linking
            };

        } catch (error) {
            this.logger.error(`Failed to create Plaid link token for user ${userId}:`, error);

            // Handle Plaid API errors
            if (error.response) {
                const status = error.response.status;
                const plaidError = error.response.data;
                const message = plaidError?.error_message || error.message;

                if (status === 401) {
                    throw new ConfigurationException(
                        IntegrationProviderName.PLAID,
                        'Invalid Plaid credentials. Please check CLIENT_ID and SECRET.'
                    );
                } else if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.PLAID,
                        error.response.headers['retry-after']
                    );
                } else {
                    throw new ProviderAPIException(
                        IntegrationProviderName.PLAID,
                        `Failed to create link token: ${message}`,
                        status
                    );
                }
            }

            throw new ProviderAPIException(
                IntegrationProviderName.PLAID,
                `Unexpected error creating link token: ${error.message}`
            );
        }
    }

    async handleCallback(payload: CallbackPayload): Promise<void> {
        this.logger.log(`Handling Plaid callback`);

        const { public_token, state, metadata } = payload as any;

        if (!public_token || !state) {
            throw new InvalidCallbackException(
                IntegrationProviderName.PLAID,
                'Missing public_token or state parameter'
            );
        }

        // Extract userId from state format: "plaid-<userId>-<ts>"
        const stateStr = String(state);
        if (!stateStr.startsWith('plaid-')) {
            throw new InvalidCallbackException(
                IntegrationProviderName.PLAID,
                'Invalid state format: must start with plaid-'
            );
        }

        const stateWithoutPrefix = stateStr.replace(/^plaid-/, '');
        const lastDashIndex = stateWithoutPrefix.lastIndexOf('-');
        const userId = lastDashIndex > 0 ? stateWithoutPrefix.substring(0, lastDashIndex) : stateWithoutPrefix;
        if (!userId || lastDashIndex <= 0) {
            throw new InvalidCallbackException(
                IntegrationProviderName.PLAID,
                'Invalid state format: unable to extract userId'
            );
        }

        try {
            // Exchange public token for access token
            const request: ItemPublicTokenExchangeRequest = {
                public_token,
            };

            const response = await this.getPlaidClient().itemPublicTokenExchange(request);
            const accessToken = response.data.access_token;
            const itemId = response.data.item_id;

            // Store access token
            await this.tokens.set(userId, 'plaid', {
                accessToken,
                providerUserId: itemId,
                // Plaid access tokens don't expire
                expiresAt: Math.floor(Date.now() / 1000) + 31536000, // 1 year for tracking
            });


            // // Store metadata if available
            // if (metadata) {
            //     await this.tokens.set(userId, 'plaid_metadata', {
            //         accessToken: JSON.stringify(metadata),
            //         expiresAt: Math.floor(Date.now() / 1000) + 31536000,
            //     });
            // }

            // Mark as connected
            const integration = await this.persistence.ensureIntegration('plaid');
            await this.persistence.markConnected(userId, integration.integrationId);

            this.logger.log(`Plaid connected successfully for user ${userId}`);

            // Automatically sync user data after successful connection
            try {
                this.logger.log(`Starting automatic sync for user ${userId} after Plaid connection`);
                const syncResult = await this.sync(userId);
                this.logger.log(`Automatic sync completed for user ${userId}:`, syncResult);
            } catch (syncError) {
                this.logger.error(`Automatic sync failed for user ${userId}:`, syncError);
                // Don't throw error here as connection was successful, sync can be retried later
            }

        } catch (error) {
            this.logger.error(`Failed to handle Plaid callback for user ${userId}:`, error);

            // If it's already one of our custom exceptions, re-throw it
            if (error instanceof InvalidCallbackException) {
                throw error;
            }

            // Handle Plaid API errors
            if (error.response) {
                const status = error.response.status;
                const plaidError = error.response.data;
                const message = plaidError?.error_message || error.message;

                if (status === 401 || status === 403) {
                    throw new OAuthAuthenticationException(
                        IntegrationProviderName.PLAID,
                        `Failed to exchange public token: ${message}`
                    );
                } else if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.PLAID,
                        error.response.headers['retry-after']
                    );
                } else {
                    throw new ProviderAPIException(
                        IntegrationProviderName.PLAID,
                        `Token exchange failed: ${message}`,
                        status
                    );
                }
            }

            // Generic error
            throw new OAuthAuthenticationException(
                IntegrationProviderName.PLAID,
                `Unexpected error during callback: ${error.message}`
            );
        }
    }

    async sync(userId: string): Promise<{ ok: boolean; syncedAt?: Date; details?: any }> {
        const integration = await this.persistence.ensureIntegration('plaid');
        const sinceDate =
            (await this.persistence.getLastSyncedAt(userId, integration.integrationId)) ??
            new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Default to 30 days

        try {
            const tokenData = await this.tokens.get(userId, 'plaid');
            if (!tokenData) {
                throw new InvalidTokenException(
                    IntegrationProviderName.PLAID
                );
            }

            const accessToken = tokenData.accessToken;
            let totalItems = 0;

            // Fetch accounts
            const accounts = await this.fetchAccounts(accessToken);

            // Process and store accounts
            if (accounts.length > 0) {
                await this.processAccounts(userId, accounts);
                totalItems += accounts.length;
            }

            // Fetch transactions for each account
            const transactions = await this.fetchTransactions(accessToken, sinceDate);

            if (transactions.length > 0) {
                await this.processTransactions(userId, transactions, accounts);
                totalItems += transactions.length;
            }

            // Mark as synced
            const link = await this.db.userIntegrations.findFirst({
                where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            });

            if (link) {
                await this.persistence.markSynced(link.userIntegrationId);
            }

            return {
                ok: true,
                syncedAt: new Date(),
                details: {
                    totalItems,
                    transactions: transactions.length,
                    accounts: accounts.length,
                    since: sinceDate
                }
            };

        } catch (error) {
            this.logger.error(`Plaid sync failed for user ${userId}:`, error);

            // If it's already one of our custom exceptions, re-throw it
            if (error instanceof InvalidTokenException ||
                error instanceof RateLimitException ||
                error instanceof ProviderAPIException) {
                throw error;
            }

            // Handle Plaid API errors
            if (error.response) {
                const status = error.response.status;
                const plaidError = error.response.data;
                const message = plaidError?.error_message || error.message;

                if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.PLAID,
                        error.response.headers['retry-after']
                    );
                } else if (status === 401 || status === 403) {
                    throw new InvalidTokenException(
                        IntegrationProviderName.PLAID
                    );
                } else {
                    throw new ProviderAPIException(
                        IntegrationProviderName.PLAID,
                        `Plaid API error during sync: ${message}`,
                        status
                    );
                }
            }

            // Generic sync error
            throw new DataSyncException(
                IntegrationProviderName.PLAID,
                `Failed to sync Plaid data: ${error.message}`
            );
        }
    }

    async status(userId: string): Promise<{ connected: boolean; lastSyncedAt?: Date | null; details?: any }> {
        const integration = await this.persistence.ensureIntegration('plaid');
        const link = await this.db.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
        });

        const history = link
            ? await this.db.userIntegrationHistory.findFirst({
                where: { userIntegrationId: link.userIntegrationId, userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            })
            : null;

        // Check if tokens exist
        const tokens = await this.tokens.get(userId, 'plaid');

        return {
            connected: !!link && link.status === 'CONNECTED',
            lastSyncedAt: history?.lastSyncedAt ?? null,
            details: {
                integrationId: integration.integrationId,
                popularity: integration.popularity,
                hasTokens: !!tokens,
                itemId: tokens?.providerUserId,
            }
        };
    }

    private async fetchAccounts(accessToken: string): Promise<PlaidAccount[]> {
        const request: AccountsGetRequest = {
            access_token: accessToken,
        };

        const response = await this.getPlaidClient().accountsGet(request);
        return response.data.accounts;
    }

    private async fetchTransactions(accessToken: string, since: Date): Promise<Transaction[]> {
        const endDate = new Date();
        const startDate = since;

        const request: TransactionsGetRequest = {
            access_token: accessToken,
            start_date: startDate.toISOString().split('T')[0], // YYYY-MM-DD format
            end_date: endDate.toISOString().split('T')[0],
        };

        const response = await this.getPlaidClient().transactionsGet(request);
        let transactions = response.data.transactions;

        // If there are more transactions, fetch them
        const totalTransactions = response.data.total_transactions;
        if (totalTransactions > transactions.length) {
            const remainingRequests = Math.ceil((totalTransactions - transactions.length) / 500);

            for (let i = 1; i <= remainingRequests && i <= 10; i++) { // Limit to 10 additional requests
                const additionalRequest: TransactionsGetRequest = {
                    ...request,
                };

                const additionalResponse = await this.getPlaidClient().transactionsGet(additionalRequest);
                transactions = transactions.concat(additionalResponse.data.transactions);
            }
        }

        return transactions;
    }

    private async processTransactions(userId: string, transactions: Transaction[], accounts: PlaidAccount[]): Promise<void> {
        // Create a map of account IDs to account names for easier lookup
        const accountMap = new Map(accounts.map(account => [account.account_id, account]));

        for (const transaction of transactions) {
            const account = accountMap.get(transaction.account_id);
            const category = this.categorizeTransaction(transaction);
            const { list, userList, category: listCategory } = await this.persistence.ensureListAndCategoryForUser(userId, category.listType, category.categoryName);

            const transactionDate = new Date(transaction.date);
            const amount = Math.abs(transaction.amount); // Plaid uses positive for debits, negative for credits

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                listCategory?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `${account?.name} | Transactions`,
                {
                    transactionDate: transactionDate.toISOString(),
                    transactionName: transaction.name,
                    merchantName: transaction.merchant_name,
                    amount: amount,
                    currency: transaction.iso_currency_code || transaction.unofficial_currency_code || 'USD',
                    category: transaction.category,
                    categoryId: transaction.category_id,
                    accountName: account?.name,
                    accountType: account?.type,
                    accountSubtype: account?.subtype,
                    paymentChannel: transaction.payment_channel,
                    pending: transaction.pending,
                    location: transaction.location ? {
                        address: transaction.location.address,
                        city: transaction.location.city,
                        region: transaction.location.region,
                        postalCode: transaction.location.postal_code,
                        country: transaction.location.country,
                        coordinates: transaction.location.lat && transaction.location.lon ? {
                            lat: transaction.location.lat,
                            lon: transaction.location.lon,
                        } : null,
                        storeNumber: transaction.location.store_number,
                    } : null,
                    external: {
                        provider: 'plaid',
                        id: transaction.transaction_id,
                        accountId: transaction.account_id,
                        type: 'transaction'
                    },
                },
                {
                    transactionDate: DATA_TYPE.STRING,
                    transactionName: DATA_TYPE.STRING,
                    merchantName: DATA_TYPE.STRING,
                    amount: DATA_TYPE.STRING,
                    currency: DATA_TYPE.STRING,
                    category: DATA_TYPE.STRING,
                    categoryId: DATA_TYPE.STRING,
                    accountName: DATA_TYPE.STRING,
                    accountType: DATA_TYPE.STRING,
                    accountSubtype: DATA_TYPE.STRING,
                    paymentChannel: DATA_TYPE.STRING,
                    pending: DATA_TYPE.BOOLEAN,
                    location: {
                        address: DATA_TYPE.STRING,
                        city: DATA_TYPE.STRING,
                        region: DATA_TYPE.STRING,
                        postalCode: DATA_TYPE.STRING,
                        country: DATA_TYPE.STRING,
                        coordinates: {
                            lat: DATA_TYPE.NUMBER,
                            lon: DATA_TYPE.NUMBER,
                        },
                        storeNumber: DATA_TYPE.STRING,
                    },
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        accountId: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private async processAccounts(userId: string, accounts: PlaidAccount[]): Promise<void> {
        // Store accounts in the Financial list
        const { list, userList, category: listCategory } = await this.persistence.ensureListAndCategoryForUser(userId, 'Financial', 'Accounts');

        for (const account of accounts) {
            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                listCategory?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `${account.name} | Accounts`,
                {
                    accountId: account.account_id,
                    accountName: account.name,
                    officialName: account.official_name,
                    accountType: account.type,
                    accountSubtype: account.subtype,
                    mask: account.mask,
                    balances: {
                        available: account.balances.available,
                        current: account.balances.current,
                        limit: account.balances.limit,
                        currency: account.balances.iso_currency_code || account.balances.unofficial_currency_code || 'USD',
                    },
                    external: {
                        provider: 'plaid',
                        id: account.account_id,
                        type: 'account'
                    },
                },
                {
                    accountId: DATA_TYPE.STRING,
                    accountName: DATA_TYPE.STRING,
                    officialName: DATA_TYPE.STRING,
                    accountType: DATA_TYPE.STRING,
                    accountSubtype: DATA_TYPE.STRING,
                    mask: DATA_TYPE.STRING,
                    balances: {
                        available: DATA_TYPE.STRING,
                        current: DATA_TYPE.STRING,
                        limit: DATA_TYPE.STRING,
                        currency: DATA_TYPE.STRING,
                    },
                    external: { provider: DATA_TYPE.STRING, id: DATA_TYPE.STRING, type: DATA_TYPE.STRING },
                }
            );
        }
    }

    private categorizeTransaction(transaction: Transaction): { listType: string; categoryName: string } {
        const categories = transaction.category || [];
        const primaryCategory = categories[0]?.toLowerCase() || '';
        const merchantName = (transaction.merchant_name || transaction.name || '').toLowerCase();

        // Travel-related transactions
        if (primaryCategory.includes('travel') ||
            primaryCategory.includes('airlines') ||
            primaryCategory.includes('hotels') ||
            merchantName.includes('airline') ||
            merchantName.includes('hotel') ||
            merchantName.includes('airbnb') ||
            merchantName.includes('booking') ||
            merchantName.includes('expedia')) {
            return { listType: 'Travel', categoryName: 'Travel Expenses' };
        }

        // Transportation
        if (primaryCategory.includes('transportation') ||
            primaryCategory.includes('gas') ||
            primaryCategory.includes('taxi') ||
            primaryCategory.includes('uber') ||
            primaryCategory.includes('lyft') ||
            merchantName.includes('uber') ||
            merchantName.includes('lyft') ||
            merchantName.includes('taxi') ||
            merchantName.includes('gas') ||
            merchantName.includes('shell') ||
            merchantName.includes('exxon') ||
            merchantName.includes('chevron')) {
            return { listType: 'Transport', categoryName: 'Transportation' };
        }

        // Food and dining
        if (primaryCategory.includes('food') ||
            primaryCategory.includes('restaurants') ||
            primaryCategory.includes('fast food') ||
            primaryCategory.includes('coffee') ||
            merchantName.includes('restaurant') ||
            merchantName.includes('starbucks') ||
            merchantName.includes('mcdonald') ||
            merchantName.includes('pizza') ||
            merchantName.includes('cafe')) {
            return { listType: 'Food', categoryName: 'Dining' };
        }

        // Groceries
        if (primaryCategory.includes('groceries') ||
            primaryCategory.includes('supermarket') ||
            merchantName.includes('grocery') ||
            merchantName.includes('walmart') ||
            merchantName.includes('target') ||
            merchantName.includes('safeway') ||
            merchantName.includes('kroger')) {
            return { listType: 'Food', categoryName: 'Groceries' };
        }

        // Entertainment and places
        if (primaryCategory.includes('entertainment') ||
            primaryCategory.includes('recreation') ||
            primaryCategory.includes('gyms') ||
            primaryCategory.includes('movie') ||
            merchantName.includes('gym') ||
            merchantName.includes('fitness') ||
            merchantName.includes('cinema') ||
            merchantName.includes('theater')) {
            return { listType: 'Places', categoryName: 'Entertainment' };
        }

        // Shopping
        if (primaryCategory.includes('shops') ||
            primaryCategory.includes('retail') ||
            primaryCategory.includes('clothing') ||
            merchantName.includes('amazon') ||
            merchantName.includes('store')) {
            return { listType: 'Places', categoryName: 'Shopping' };
        }

        // Default to general expenses
        return { listType: 'Places', categoryName: 'General Expenses' };
    }

    async disconnect(userId: string): Promise<void> {
        this.logger.log(`Disconnecting Plaid for user ${userId}`);

        try {
            // Get the access token before deletion
            const tokens = await this.tokens.get(userId, 'plaid');

            if (tokens?.accessToken) {
                // Remove the item from Plaid
                // This revokes the access token and removes the item
                try {
                    await this.getPlaidClient().itemRemove({
                        access_token: tokens.accessToken,
                    });
                    this.logger.log(`Successfully removed Plaid item for user ${userId}`);
                } catch (error) {
                    // Log but don't throw - token might already be invalid or item removed
                    this.logger.warn(`Failed to remove Plaid item for user ${userId}:`, error);
                }
            }

            // Delete stored tokens
            await this.tokens.delete(userId, 'plaid');

            // Update user integration status to DISCONNECTED
            const integration = await this.persistence.ensureIntegration('plaid');
            const link = await this.db.userIntegrations.findFirst({
                where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            });

            if (link) {
                await this.db.userIntegrations.update({
                    where: {
                        userIntegrationId_recSeq: {
                            userIntegrationId: link.userIntegrationId,
                            recSeq: link.recSeq,
                        },
                    },
                    data: { status: STATUS.DISCONNECTED },
                });
            }

        } catch (error) {
            this.logger.error(`Error during Plaid disconnect for user ${userId}:`, error);
            // Don't throw - allow disconnect to continue even if item removal fails
        }

        this.logger.log(`Plaid disconnect completed for user ${userId}`);
    }
}