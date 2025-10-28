import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationProviderName, ConnectResponse, CallbackPayload } from '../types';
import { URLSearchParams } from 'url';
import { IntegrationPersistence } from '../persistence';
import { PrismaService } from '@traeta/prisma';
import { TokenStore } from '../token-store';
import { google } from 'googleapis';
import axios from 'axios';
import {
    ConfigurationException,
    InvalidCallbackException,
    InvalidTokenException,
    DataSyncException,
    ProviderAPIException,
    RateLimitException,
    OAuthAuthenticationException,
} from '../exceptions/integration.exceptions';
import { DATA_TYPE, REC_SEQ } from '../../../constants';

interface EmailAttachment {
    filename: string;
    mimeType: string;
    size: number;
}

interface GmailMessage {
    id: string;
    threadId: string;
    labelIds: string[];
    snippet: string;
    payload: {
        partId: string;
        mimeType: string;
        filename: string;
        headers: Array<{
            name: string;
            value: string;
        }>;
        body: {
            attachmentId?: string;
            size: number;
            data?: string;
        };
        parts?: Array<{
            partId: string;
            mimeType: string;
            filename: string;
            headers: Array<{
                name: string;
                value: string;
            }>;
            body: {
                attachmentId?: string;
                size: number;
                data?: string;
            };
        }>;
    };
    sizeEstimate: number;
    historyId: string;
    internalDate: string;
}

interface EmailData {
    id: string;
    subject: string;
    from: string;
    to: string;
    date: Date;
    body: string;
    snippet: string;
    labels: string[];
    attachments: Array<{
        filename: string;
        mimeType: string;
        size: number;
    }>;
}

@Injectable()
export class EmailScraperProvider implements IntegrationProvider {
    public readonly name = IntegrationProviderName.EMAIL_SCRAPER;
    private readonly logger = new Logger(EmailScraperProvider.name);

    constructor(
        private readonly db: PrismaService,
        private readonly persistence: IntegrationPersistence,
        private readonly tokens: TokenStore,
        private readonly configService: ConfigService,
    ) { }

    private getGoogleClientId(): string {
        return this.configService.get<string>('GMAIL_CLIENT_ID') ||
            this.configService.get<string>('GOOGLE_CLIENT_ID') || '';
    }

    private getGoogleClientSecret(): string {
        return this.configService.get<string>('GMAIL_CLIENT_SECRET') ||
            this.configService.get<string>('GOOGLE_CLIENT_SECRET') || '';
    }

    private getGoogleRedirectUri(): string {
        return this.configService.get<string>('GMAIL_REDIRECT_URI') ||
            this.configService.get<string>('GOOGLE_REDIRECT_URI') ||
            'http://localhost:3000/integrations/gmail/callback';
    }

    private getDefaultDays(): number {
        const days = this.configService.get<string>('GMAIL_DEFAULT_DAYS');
        return days ? Number(days) : 90;
    }

    async createConnection(userId: string): Promise<ConnectResponse> {
        // Validate configuration
        const clientId = this.getGoogleClientId();
        const clientSecret = this.getGoogleClientSecret();
        const redirectUri = this.getGoogleRedirectUri();

        if (!clientId || !clientSecret || !redirectUri) {
            throw new ConfigurationException(
                IntegrationProviderName.EMAIL_SCRAPER,
                'Missing required Gmail OAuth configuration (CLIENT_ID, CLIENT_SECRET, or REDIRECT_URI)'
            );
        }

        try {
            const state = `email-${userId}-${Date.now()}`;
            const params = new URLSearchParams({
                client_id: clientId,
                response_type: 'code',
                redirect_uri: redirectUri,
                scope: 'https://mail.google.com/ openid email profile',
                access_type: 'offline',
                prompt: 'consent',
                include_granted_scopes: 'true',
                state,
            });
            const redirectUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
            await this.persistence.ensureIntegration('email_scraper');
            return { provider: this.name, redirectUrl, state };
        } catch (error) {
            this.logger.error(`Failed to create Gmail connection for user ${userId}:`, error);

            if (error instanceof ConfigurationException) {
                throw error;
            }

            throw new ConfigurationException(
                IntegrationProviderName.EMAIL_SCRAPER,
                `Failed to initialize Gmail connection: ${error.message}`
            );
        }
    }

    async handleCallback(payload: CallbackPayload): Promise<void> {
        this.logger.log(`Email scraper callback received`);
        const { code, state, error } = payload;

        if (error) {
            throw new OAuthAuthenticationException(
                IntegrationProviderName.EMAIL_SCRAPER,
                `Gmail OAuth error: ${error}`
            );
        }

        if (!code || !state) {
            throw new InvalidCallbackException(
                IntegrationProviderName.EMAIL_SCRAPER,
                'Missing required callback parameters: code or state'
            );
        }

        // Extract userId from state format: "email-<userId>-<ts>"
        // Remove "email-" prefix and "-<timestamp>" suffix
        const stateStr = String(state);
        const stateWithoutPrefix = stateStr.replace(/^email-/, '');
        const lastDashIndex = stateWithoutPrefix.lastIndexOf('-');
        const userId = lastDashIndex > 0 ? stateWithoutPrefix.substring(0, lastDashIndex) : stateWithoutPrefix;
        if (!userId) {
            throw new InvalidCallbackException(
                IntegrationProviderName.EMAIL_SCRAPER,
                'Invalid state format: unable to extract userId'
            );
        }

        try {
            // Exchange authorization code for tokens
            const tokenUrl = 'https://oauth2.googleapis.com/token';
            const clientId = this.getGoogleClientId();
            const clientSecret = this.getGoogleClientSecret();
            const redirectUri = this.getGoogleRedirectUri();

            const tokenResponse = await axios.post(tokenUrl, new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });

            const tokenData = tokenResponse.data;
            const expiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in;

            // Get user profile
            const userProfile = await this.fetchUserProfile(tokenData.access_token);

            // Store tokens
            await this.tokens.set(userId, 'email_scraper', {
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token,
                expiresAt,
                scope: tokenData.scope,
                providerUserId: userProfile.email,
            });

            // Mark as connected
            const integration = await this.persistence.ensureIntegration('email_scraper');
            await this.persistence.markConnected(userId, integration.integrationId);

            this.logger.log(`Gmail connected successfully for user ${userId}`);

            // Automatically sync user data after successful connection
            try {
                this.logger.log(`Starting automatic sync for user ${userId} after Gmail connection`);
                const syncResult = await this.sync(userId);
                this.logger.log(`Automatic sync completed for user ${userId}:`, syncResult);
            } catch (syncError) {
                this.logger.error(`Automatic sync failed for user ${userId}:`, syncError);
                // Don't throw error here as connection was successful, sync can be retried later
            }

        } catch (error) {
            this.logger.error(`Failed to handle Gmail callback for user ${userId}:`, error);

            // Re-throw custom exceptions
            if (error instanceof InvalidCallbackException ||
                error instanceof OAuthAuthenticationException) {
                throw error;
            }

            // Handle Axios errors
            if (error.response) {
                const status = error.response.status;
                const errorMessage = error.response.data?.error_description ||
                    error.response.data?.error ||
                    error.message;

                if (status === 400 || status === 401) {
                    throw new OAuthAuthenticationException(
                        IntegrationProviderName.EMAIL_SCRAPER,
                        `Gmail authentication failed: ${errorMessage}`
                    );
                }
            }

            throw new InvalidCallbackException(
                IntegrationProviderName.EMAIL_SCRAPER,
                `Failed to process Gmail callback: ${error.message}`
            );
        }
    }

    private async ensureValidAccessToken(userId: string): Promise<string> {
        const existing = await this.tokens.get(userId, 'email_scraper');
        if (!existing) {
            throw new InvalidTokenException(
                IntegrationProviderName.EMAIL_SCRAPER
            );
        }

        const now = Math.floor(Date.now() / 1000);
        if (existing.expiresAt && existing.expiresAt - now > 60) {
            return existing.accessToken; // Still valid
        }

        if (!existing.refreshToken) {
            throw new InvalidTokenException(
                IntegrationProviderName.EMAIL_SCRAPER
            );
        }

        try {
            // Refresh the token
            const tokenUrl = 'https://oauth2.googleapis.com/token';
            const clientId = this.getGoogleClientId();
            const clientSecret = this.getGoogleClientSecret();

            const response = await axios.post(tokenUrl, new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: existing.refreshToken,
            }), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            });

            const tokenData = response.data;
            const newExpiresAt = Math.floor(Date.now() / 1000) + tokenData.expires_in;

            // Update stored tokens
            await this.tokens.set(userId, 'email_scraper', {
                accessToken: tokenData.access_token,
                refreshToken: tokenData.refresh_token || existing.refreshToken,
                expiresAt: newExpiresAt,
                scope: existing.scope,
                providerUserId: existing.providerUserId,
            });

            return tokenData.access_token;
        } catch (error) {
            if (error.response?.status === 400 || error.response?.status === 401) {
                throw new InvalidTokenException(
                    IntegrationProviderName.EMAIL_SCRAPER
                );
            }
            throw error;
        }
    }

    async sync(userId: string): Promise<{ ok: boolean; syncedAt?: Date; details?: any }> {
        const integration = await this.persistence.ensureIntegration('email_scraper');

        // Debug: Check what lastSyncedAt returns
        const lastSyncedAt = await this.persistence.getLastSyncedAt(userId, integration.integrationId);
        const defaultDays = this.getDefaultDays();
        const defaultDate = new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);

        this.logger.log(`[EMAIL SCRAPER DEBUG] User: ${userId}`);
        this.logger.log(`[EMAIL SCRAPER DEBUG] lastSyncedAt from DB: ${lastSyncedAt}`);
        this.logger.log(`[EMAIL SCRAPER DEBUG] defaultDate (90 days ago): ${defaultDate}`);
        this.logger.log(`[EMAIL SCRAPER DEBUG] defaultDays config: ${defaultDays}`);

        // Use lastSyncedAt from DB if available, otherwise use default (90 days ago)
        const sinceDate = lastSyncedAt || defaultDate;
        this.logger.log(`[EMAIL SCRAPER] Final sinceDate being used: ${sinceDate}`);
        this.logger.log(`[EMAIL SCRAPER] Incremental sync: ${!!lastSyncedAt}`);

        try {
            const accessToken = await this.ensureValidAccessToken(userId);

            // Initialize Gmail API
            const gmail = google.gmail({ version: 'v1' });
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: accessToken });

            // Fetch ALL emails and categorize them intelligently
            this.logger.log(`[EMAIL SCRAPER] Fetching emails since ${sinceDate}...`);
            const allEmails = await this.fetchEmailsByQuery(gmail, auth, 'in:inbox', sinceDate);
            this.logger.log(`[EMAIL SCRAPER] Found ${allEmails.length} total emails`);

            if (allEmails.length === 0) {
                return {
                    ok: true,
                    syncedAt: new Date(),
                    details: {
                        totalProcessed: 0,
                        totalSkipped: 0,
                        totalEmailsFetched: 0,
                        since: sinceDate,
                        message: 'No new emails to sync'
                    }
                };
            }

            // Categorize emails intelligently
            const categorizedEmails = this.categorizeEmails(allEmails);

            // Process each category with duplicate detection
            let totalProcessed = 0;
            let totalSkipped = 0;
            const categoryStats: Record<string, { processed: number; skipped: number }> = {};

            for (const [category, emails] of Object.entries(categorizedEmails)) {
                if (emails.length > 0) {
                    const categoryInfo = this.getCategoryInfo(category);
                    this.logger.log(`[EMAIL SCRAPER] Processing ${emails.length} ${category} emails...`);
                    const result = await this.processEmails(userId, emails, categoryInfo.listType, categoryInfo.categoryName);
                    totalProcessed += result.processed;
                    totalSkipped += result.skipped;
                    categoryStats[category] = result;
                }
            }

            // Find the most recent email date to use as lastSyncedAt
            const mostRecentEmailDate = allEmails.reduce((latest, email) => {
                return email.date > latest ? email.date : latest;
            }, new Date(0));

            // Mark as synced with the most recent email date
            const link = await this.db.userIntegrations.findFirst({
                where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            });

            if (link) {
                await this.persistence.markSynced(link.userIntegrationId, mostRecentEmailDate);
            }

            this.logger.log(`[EMAIL SCRAPER] Sync complete: ${totalProcessed} processed, ${totalSkipped} skipped`);

            return {
                ok: true,
                syncedAt: mostRecentEmailDate,
                details: {
                    totalProcessed,
                    totalSkipped,
                    totalEmailsFetched: allEmails.length,
                    categoryStats,
                    since: sinceDate,
                    nextSyncFrom: mostRecentEmailDate
                }
            };

        } catch (error) {
            this.logger.error(`Email scraper sync failed for user ${userId}:`, error);

            // Re-throw custom exceptions
            if (error instanceof InvalidTokenException ||
                error instanceof DataSyncException ||
                error instanceof ProviderAPIException ||
                error instanceof RateLimitException) {
                throw error;
            }

            // Handle Gmail API errors
            if (error.response) {
                const status = error.response.status;
                const errorMessage = error.response.data?.error?.message || error.message;

                if (status === 401 || status === 403) {
                    throw new InvalidTokenException(
                        IntegrationProviderName.EMAIL_SCRAPER
                    );
                } else if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.EMAIL_SCRAPER
                    );
                } else if (status >= 500) {
                    throw new ProviderAPIException(
                        IntegrationProviderName.EMAIL_SCRAPER,
                        `Gmail API error: ${errorMessage}`
                    );
                }
            }

            // Generic fallback
            throw new DataSyncException(
                IntegrationProviderName.EMAIL_SCRAPER,
                `Failed to sync Gmail data: ${error.message}`
            );
        }
    }

    async status(userId: string): Promise<{ connected: boolean; lastSyncedAt?: Date | null; details?: any }> {
        const integration = await this.persistence.ensureIntegration('email_scraper');
        const link = await this.db.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
        });

        const history = link
            ? await this.db.userIntegrationHistory.findFirst({
                where: { userIntegrationId: link.userIntegrationId, userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            })
            : null;

        // Check if tokens are still valid
        const tokens = await this.tokens.get(userId, 'email_scraper');

        return {
            connected: !!link && link.status === 'CONNECTED',
            lastSyncedAt: history?.lastSyncedAt ?? null,
            details: {
                integrationId: integration.integrationId,
                popularity: integration.popularity,
                hasTokens: !!tokens,
                tokenExpiry: tokens?.expiresAt ? new Date(tokens.expiresAt * 1000) : null,
                email: tokens?.providerUserId,
            }
        };
    }

    private async fetchUserProfile(accessToken: string): Promise<{ email: string; name: string }> {
        const response = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
        });
        return {
            email: response.data.email,
            name: response.data.name,
        };
    }

    private async fetchEmailsByQuery(gmail: any, auth: any, query: string, since: Date): Promise<EmailData[]> {
        try {
            const sinceTimestamp = Math.floor(since.getTime() / 1000);
            const fullQuery = `${query} after:${sinceTimestamp}`;

            this.logger.log(`[GMAIL QUERY] Query: ${fullQuery}`);
            this.logger.log(`[GMAIL QUERY] Since date: ${since.toISOString()}`);
            this.logger.log(`[GMAIL QUERY] Since timestamp: ${sinceTimestamp}`);

            // Search for messages
            const searchResponse = await gmail.users.messages.list({
                auth,
                userId: 'me',
                q: fullQuery,
                maxResults: 100,
            });

            const messages = searchResponse.data.messages || [];
            this.logger.log(`[GMAIL QUERY] Found ${messages.length} messages`);

            const emailData: EmailData[] = [];

            // Fetch details for each message
            for (const message of messages.slice(0, 50)) { // Limit to 50 emails per query
                try {
                    const messageResponse = await gmail.users.messages.get({
                        auth,
                        userId: 'me',
                        id: message.id,
                        format: 'full',
                    });

                    const emailInfo = this.parseEmailMessage(messageResponse.data);
                    if (emailInfo) {
                        emailData.push(emailInfo);
                    }
                } catch (error) {
                    this.logger.warn(`Failed to fetch email ${message.id}:`, error);
                }
            }

            return emailData;

        } catch (error) {
            this.logger.error(`Failed to fetch emails with query "${query}":`, error);
            return [];
        }
    }

    private parseEmailMessage(message: GmailMessage): EmailData | null {
        try {
            const headers = message.payload.headers;
            const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '';
            const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || '';
            const to = headers.find(h => h.name.toLowerCase() === 'to')?.value || '';
            const dateHeader = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';

            const date = dateHeader ? new Date(dateHeader) : new Date(parseInt(message.internalDate));

            // Extract body text
            let body = '';
            if (message.payload.body.data) {
                body = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
            } else if (message.payload.parts) {
                for (const part of message.payload.parts) {
                    if (part.mimeType === 'text/plain' && part.body.data) {
                        body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                        break;
                    }
                }
            }

            // Extract attachments info
            const attachments: EmailAttachment[] = [];
            if (message.payload.parts) {
                for (const part of message.payload.parts) {
                    if (part.filename && part.filename.length > 0) {
                        attachments.push({
                            filename: part.filename,
                            mimeType: part.mimeType,
                            size: part.body.size,
                        });
                    }
                }
            }

            return {
                id: message.id,
                subject,
                from,
                to,
                date,
                body: body.substring(0, 1000), // Limit body size
                snippet: message.snippet,
                labels: message.labelIds || [],
                attachments,
            };

        } catch (error) {
            this.logger.error('Failed to parse email message:', error);
            return null;
        }
    }

    private async processEmails(userId: string, emails: EmailData[], listType: string, categoryName: string): Promise<{ processed: number; skipped: number }> {
        let processed = 0;
        let skipped = 0;

        for (const email of emails) {
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, listType, categoryName);

            // Check for duplicates
            const exists = await this.persistence.emailExists(list.listId, list.recSeq, email.id);
            if (exists) {
                this.logger.debug(`Skipping duplicate email: ${email.id}`);
                skipped++;
                continue;
            }

            // Extract relevant information based on email content
            const extractedInfo = this.extractEmailInfo(email, listType);

            await this.persistence.createListItem(
                list.listId,
                list.recSeq,
                userList.userListId,
                userList.recSeq,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `${email.subject} | ${listType} | Emails`,
                {
                    emailDate: email.date.toISOString(),
                    subject: email.subject,
                    from: email.from,
                    to: email.to,
                    snippet: email.snippet,
                    body: email.body,
                    attachmentCount: email.attachments.length,
                    attachments: email.attachments,
                    labels: email.labels,
                    ...extractedInfo, // Add extracted information
                    external: {
                        provider: 'gmail',
                        id: email.id,
                        type: 'email'
                    },
                },
                {
                    emailDate: DATA_TYPE.STRING,
                    subject: DATA_TYPE.STRING,
                    from: DATA_TYPE.STRING,
                    to: DATA_TYPE.STRING,
                    snippet: DATA_TYPE.STRING,
                    body: DATA_TYPE.STRING,
                    attachmentCount: DATA_TYPE.NUMBER,
                    attachments: DATA_TYPE.JSON,
                    labels: DATA_TYPE.JSON,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING
                    }
                }
            );
            processed++;
        }

        return { processed, skipped };
    }

    private extractEmailInfo(email: EmailData, listType: string): any {
        const subject = email.subject.toLowerCase();
        const body = email.body.toLowerCase();
        const from = email.from.toLowerCase();
        const originalBody = email.body;
        const originalSubject = email.subject;

        const info: any = {};

        // FIX #2: Extract common information (amount, dates, times, locations, "with who")
        const amountMatch = body.match(/\$(\d+(?:\.\d{2})?)/);
        if (amountMatch) {
            info.amount = parseFloat(amountMatch[1]);
        }

        const dateMatch = body.match(/(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
            info.date = dateMatch[1];
        }

        // Extract time information
        const timeMatch = body.match(/(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)/);
        if (timeMatch) {
            info.time = timeMatch[1];
        }

        // Extract "with who" information - look for common patterns
        const withWhoPatterns = [
            /(?:with|guest|passenger|traveler|attendee)(?:s)?:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
            /(?:accompanied by|traveling with|joined by):\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
            /guest(?:s)?\s+name(?:s)?:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i
        ];

        for (const pattern of withWhoPatterns) {
            const match = originalBody.match(pattern);
            if (match) {
                info.withWho = match[1].trim();
                break;
            }
        }

        if (listType === 'Travel') {
            // Extract travel-related information
            if (from.includes('booking.com') || from.includes('hotels.com')) {
                info.type = 'hotel_booking';
                info.provider = 'booking_platform';
            } else if (from.includes('airbnb.com')) {
                info.type = 'accommodation';
                info.provider = 'airbnb';
            } else if (from.includes('delta.com') || from.includes('united.com') || from.includes('american.com') ||
                from.includes('southwest.com') || from.includes('jetblue.com') || from.includes('spirit.com')) {
                info.type = 'flight';
                info.provider = 'airline';

                // Extract airline name
                if (from.includes('delta')) info.companyName = 'Delta Airlines';
                else if (from.includes('united')) info.companyName = 'United Airlines';
                else if (from.includes('american')) info.companyName = 'American Airlines';
                else if (from.includes('southwest')) info.companyName = 'Southwest Airlines';
                else if (from.includes('jetblue')) info.companyName = 'JetBlue';
                else if (from.includes('spirit')) info.companyName = 'Spirit Airlines';
            }

            // Extract location information (city, state, country)
            const cityStatePattern = /(?:to|in|at|destination|location):\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})/i;
            const cityCountryPattern = /(?:to|in|at|destination|location):\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z][a-z]+)/i;

            const cityStateMatch = originalBody.match(cityStatePattern);
            if (cityStateMatch) {
                info.city = cityStateMatch[1].trim();
                info.state = cityStateMatch[2].trim();
                info.travelType = 'Domestic';
            } else {
                const cityCountryMatch = originalBody.match(cityCountryPattern);
                if (cityCountryMatch) {
                    info.city = cityCountryMatch[1].trim();
                    info.country = cityCountryMatch[2].trim();
                    info.travelType = 'International';
                }
            }

            // Extract start and end dates
            const checkInMatch = body.match(/check-?in(?:\s+date)?:\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i);
            const checkOutMatch = body.match(/check-?out(?:\s+date)?:\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i);

            if (checkInMatch) info.startDate = checkInMatch[1];
            if (checkOutMatch) info.endDate = checkOutMatch[1];

            // For flights, extract departure and arrival
            const departureMatch = body.match(/depart(?:ure)?(?:\s+date)?:\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i);
            const arrivalMatch = body.match(/arrival(?:\s+date)?:\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i);

            if (departureMatch) info.startDate = departureMatch[1];
            if (arrivalMatch) info.endDate = arrivalMatch[1];

            // Extract confirmation/booking number
            const confirmationMatch = body.match(/confirmation\s*(?:number|code|#)?:\s*([A-Z0-9-]+)/i);
            if (confirmationMatch) {
                info.confirmationNumber = confirmationMatch[1];
            }
        }

        if (listType === 'Food') {
            if (from.includes('doordash.com')) {
                info.type = 'food_delivery';
                info.provider = 'doordash';
            } else if (from.includes('ubereats.com')) {
                info.type = 'food_delivery';
                info.provider = 'uber_eats';
            } else if (from.includes('grubhub.com')) {
                info.type = 'food_delivery';
                info.provider = 'grubhub';
            } else if (from.includes('postmates.com')) {
                info.type = 'food_delivery';
                info.provider = 'postmates';
            } else if (from.includes('opentable.com') || from.includes('resy.com')) {
                info.type = 'restaurant_reservation';
                info.provider = from.includes('opentable') ? 'opentable' : 'resy';
            }

            // Extract restaurant name
            const restaurantPatterns = [
                /(?:from|restaurant|at):\s*([A-Z][a-zA-Z\s&'-]+?)(?:\s*-|\s*\n|$)/i,
                /order from\s+([A-Z][a-zA-Z\s&'-]+?)(?:\s*-|\s*\n|$)/i
            ];

            for (const pattern of restaurantPatterns) {
                const match = originalBody.match(pattern);
                if (match) {
                    info.restaurantName = match[1].trim();
                    break;
                }
            }

            // Extract address
            const addressPattern = /(?:address|location):\s*([0-9]+\s+[A-Za-z\s,]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)[^,\n]*(?:,\s*[A-Z]{2}\s*\d{5})?)/i;
            const addressMatch = originalBody.match(addressPattern);
            if (addressMatch) {
                info.address = addressMatch[1].trim();
            }

            // Categorize by meal type based on time or keywords
            const timeStr = info.time || '';
            const hour = timeStr ? parseInt(timeStr.split(':')[0]) : 0;

            if (subject.includes('coffee') || body.includes('coffee') || body.includes('starbucks') || body.includes('cafe')) {
                info.mealType = 'Coffee Shops';
            } else if (hour >= 6 && hour < 11) {
                info.mealType = 'Breakfast';
            } else if (hour >= 11 && hour < 15) {
                info.mealType = 'Lunch';
            } else if (hour >= 17 && hour < 23) {
                info.mealType = 'Dinner';
            } else if (subject.includes('dessert') || body.includes('dessert') || body.includes('ice cream') || body.includes('bakery')) {
                info.mealType = 'Sweet Treat';
            } else if (subject.includes('bar') || body.includes('bar') || body.includes('drinks')) {
                info.mealType = 'Drinks';
            }

            // Extract cuisine type
            const cuisineKeywords = ['italian', 'chinese', 'japanese', 'mexican', 'thai', 'indian', 'french', 'american', 'mediterranean', 'korean', 'vietnamese'];
            for (const cuisine of cuisineKeywords) {
                if (body.includes(cuisine)) {
                    info.cuisineType = cuisine.charAt(0).toUpperCase() + cuisine.slice(1);
                    break;
                }
            }

            // Extract items ordered
            const itemsPattern = /(?:items?|order):\s*([^\n]+)/i;
            const itemsMatch = originalBody.match(itemsPattern);
            if (itemsMatch) {
                info.items = itemsMatch[1].trim();
            }
        }

        if (listType === 'Places') {
            // Enhanced provider detection
            if (from.includes('amazon.com')) {
                info.type = 'online_purchase';
                info.provider = 'amazon';
                info.placeName = 'Amazon';
                info.placeCategory = 'Online Shopping';
            } else if (from.includes('ebay.com')) {
                info.type = 'online_purchase';
                info.provider = 'ebay';
                info.placeName = 'eBay';
                info.placeCategory = 'Online Shopping';
            } else if (from.includes('walmart.com')) {
                info.type = 'retail_purchase';
                info.provider = 'walmart';
                info.placeName = 'Walmart';
                info.placeCategory = 'Grocery Stores';
            } else if (from.includes('target.com')) {
                info.type = 'retail_purchase';
                info.provider = 'target';
                info.placeName = 'Target';
                info.placeCategory = 'Grocery Stores';
            } else if (from.includes('costco.com')) {
                info.type = 'retail_purchase';
                info.provider = 'costco';
                info.placeName = 'Costco';
                info.placeCategory = 'Grocery Stores';
            } else if (from.includes('instacart.com')) {
                info.type = 'grocery_delivery';
                info.provider = 'instacart';
                info.placeName = 'Instacart';
                info.placeCategory = 'Grocery Stores';
            } else if (from.includes('wholefoods') || from.includes('whole foods')) {
                info.type = 'grocery_purchase';
                info.provider = 'whole_foods';
                info.placeName = 'Whole Foods';
                info.placeCategory = 'Grocery Stores';
            } else if (from.includes('safeway.com')) {
                info.type = 'grocery_purchase';
                info.provider = 'safeway';
                info.placeName = 'Safeway';
                info.placeCategory = 'Grocery Stores';
            } else if (from.includes('kroger.com')) {
                info.type = 'grocery_purchase';
                info.provider = 'kroger';
                info.placeName = 'Kroger';
                info.placeCategory = 'Grocery Stores';
            } else if (from.includes('traderjoes') || from.includes('trader joes')) {
                info.type = 'grocery_purchase';
                info.provider = 'trader_joes';
                info.placeName = 'Trader Joes';
                info.placeCategory = 'Grocery Stores';
            }

            // Enhanced place categorization with more types
            if (subject.includes('grocery') || body.includes('grocery') ||
                from.includes('instacart') || from.includes('whole foods') || from.includes('safeway') ||
                from.includes('kroger') || from.includes('trader joes') || from.includes('costco')) {
                info.placeCategory = 'Grocery Stores';
            } else if (subject.includes('museum') || body.includes('museum') || body.includes('gallery') || body.includes('exhibit')) {
                info.placeCategory = 'Museums';
            } else if (subject.includes('park') || body.includes('park') || body.includes('trail') || body.includes('nature')) {
                info.placeCategory = 'Parks';
            } else if (subject.includes('gym') || body.includes('gym') || body.includes('fitness') || body.includes('workout')) {
                info.placeCategory = 'Gyms';
            } else if (subject.includes('library') || body.includes('library')) {
                info.placeCategory = 'Libraries';
            } else if (subject.includes('mall') || body.includes('shopping center') || body.includes('shopping mall')) {
                info.placeCategory = 'Shopping Malls';
            } else if (subject.includes('salon') || body.includes('salon') || body.includes('spa') || body.includes('barber')) {
                info.placeCategory = 'Salons & Spas';
            } else if (subject.includes('hotel') || body.includes('hotel') || body.includes('resort')) {
                info.placeCategory = 'Hotels';
            } else if (subject.includes('airport') || body.includes('airport')) {
                info.placeCategory = 'Airports';
            } else if (subject.includes('beach') || body.includes('beach')) {
                info.placeCategory = 'Beaches';
            } else if (subject.includes('zoo') || body.includes('zoo') || body.includes('aquarium')) {
                info.placeCategory = 'Zoos & Aquariums';
            } else if (subject.includes('theater') || body.includes('cinema') || body.includes('movie')) {
                info.placeCategory = 'Movie Theaters';
            } else if (subject.includes('bookstore') || body.includes('bookstore') || body.includes('book shop')) {
                info.placeCategory = 'Bookstores';
            } else if (subject.includes('pharmacy') || body.includes('pharmacy') || body.includes('drugstore') ||
                from.includes('cvs') || from.includes('walgreens') || from.includes('rite aid')) {
                info.placeCategory = 'Pharmacies';
            } else if (subject.includes('gas station') || body.includes('gas station') || body.includes('fuel')) {
                info.placeCategory = 'Gas Stations';
            } else if (subject.includes('friend') || body.includes('friend') || body.includes('home visit')) {
                info.placeCategory = 'Friends Homes';
            }

            // Extract place name from subject or body if not already set
            if (!info.placeName) {
                const placeNamePattern = /(?:at|visiting|from):\s*([A-Z][a-zA-Z\s&'-]+?)(?:\s*-|\s*\n|$)/i;
                const placeNameMatch = originalBody.match(placeNamePattern) || originalSubject.match(placeNamePattern);
                if (placeNameMatch) {
                    info.placeName = placeNameMatch[1].trim();
                }
            }

            const orderMatch = body.match(/order\s*#?\s*([a-zA-Z0-9-]+)/i);
            if (orderMatch) {
                info.orderNumber = orderMatch[1];
            }

            // Extract items list (especially for grocery stores)
            const itemsListPattern = /(?:items?|products?):\s*([^\n]+(?:\n[^\n]+)*)/i;
            const itemsMatch = originalBody.match(itemsListPattern);
            if (itemsMatch) {
                const itemsText = itemsMatch[1].trim();
                // Split by common delimiters
                const items = itemsText.split(/[,\n]/).map(item => item.trim()).filter(item => item.length > 0);
                if (items.length > 0) {
                    info.itemsList = items;
                }
            }

            // Enhanced address extraction with multiple patterns
            const addressPatterns = [
                /(?:address|location|store):\s*([0-9]+\s+[A-Za-z\s,]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)[^,\n]*(?:,\s*[A-Z]{2}\s*\d{5})?)/i,
                /(?:shipped to|delivery address):\s*([0-9]+\s+[^\n]+)/i,
                /([0-9]+\s+[A-Za-z\s,]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr)[^,\n]*,\s*[A-Z][a-z]+,\s*[A-Z]{2}\s*\d{5})/i
            ];

            for (const pattern of addressPatterns) {
                const addressMatch = originalBody.match(pattern);
                if (addressMatch) {
                    info.address = addressMatch[1].trim();
                    break;
                }
            }

            // Extract city and state from address
            if (info.address) {
                const cityStateMatch = info.address.match(/,\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),\s*([A-Z]{2})/);
                if (cityStateMatch) {
                    info.city = cityStateMatch[1];
                    info.state = cityStateMatch[2];
                }
            }
        }

        if (listType === 'Transport') {
            if (from.includes('uber.com')) {
                info.transportType = 'RideShare';
                info.type = 'ride_share';
                info.provider = 'uber';
                info.companyName = 'Uber';
            } else if (from.includes('lyft.com')) {
                info.transportType = 'RideShare';
                info.type = 'ride_share';
                info.provider = 'lyft';
                info.companyName = 'Lyft';
            } else if (from.includes('zipcar.com')) {
                info.transportType = 'Car';
                info.type = 'car_rental';
                info.provider = 'zipcar';
                info.companyName = 'Zipcar';
            } else if (from.includes('metro.com') || from.includes('bart.gov') || from.includes('mta.info')) {
                info.transportType = 'Public Transport';
                info.type = 'public_transport';
                info.provider = 'transit_authority';
            } else if (from.includes('delta.com') || from.includes('united.com') || from.includes('american.com') ||
                from.includes('southwest.com') || from.includes('jetblue.com') || from.includes('spirit.com')) {
                info.transportType = 'Airplane';
                info.type = 'flight';
                info.provider = 'airline';

                // Extract airline name
                if (from.includes('delta')) info.companyName = 'Delta Airlines';
                else if (from.includes('united')) info.companyName = 'United Airlines';
                else if (from.includes('american')) info.companyName = 'American Airlines';
                else if (from.includes('southwest')) info.companyName = 'Southwest Airlines';
                else if (from.includes('jetblue')) info.companyName = 'JetBlue';
                else if (from.includes('spirit')) info.companyName = 'Spirit Airlines';
            }

            // Extract start and end locations
            const pickupPattern = /(?:pickup|pick-up|from|origin)(?:\s+location)?:\s*([^\n]+)/i;
            const dropoffPattern = /(?:dropoff|drop-off|to|destination)(?:\s+location)?:\s*([^\n]+)/i;

            const pickupMatch = originalBody.match(pickupPattern);
            const dropoffMatch = originalBody.match(dropoffPattern);

            if (pickupMatch) {
                info.startLocation = pickupMatch[1].trim();
            }
            if (dropoffMatch) {
                info.endLocation = dropoffMatch[1].trim();
            }

            // For flights, extract departure and arrival cities
            const departurePattern = /(?:depart(?:ing)?|from):\s*([A-Z]{3}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i;
            const arrivalPattern = /(?:arriv(?:ing|al)?|to):\s*([A-Z]{3}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i;

            const departureMatch = originalBody.match(departurePattern);
            const arrivalMatch = originalBody.match(arrivalPattern);

            if (departureMatch && !info.startLocation) {
                info.startLocation = departureMatch[1].trim();
            }
            if (arrivalMatch && !info.endLocation) {
                info.endLocation = arrivalMatch[1].trim();
            }

            // Extract start and end times
            const pickupTimePattern = /(?:pickup|departure|depart)(?:\s+time)?:\s*(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)/i;
            const dropoffTimePattern = /(?:dropoff|arrival|arrive)(?:\s+time)?:\s*(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)/i;

            const pickupTimeMatch = originalBody.match(pickupTimePattern);
            const dropoffTimeMatch = originalBody.match(dropoffTimePattern);

            if (pickupTimeMatch) {
                info.startTime = pickupTimeMatch[1].trim();
            }
            if (dropoffTimeMatch) {
                info.endTime = dropoffTimeMatch[1].trim();
            }

            // Extract duration
            const durationPattern = /(?:duration|trip time|travel time):\s*(\d+)\s*(?:min(?:ute)?s?|hrs?|hours?)/i;
            const durationMatch = originalBody.match(durationPattern);
            if (durationMatch) {
                info.duration = durationMatch[0].trim();
            }
        }

        // Bills & Utilities
        if (listType === 'Bills') {
            info.type = 'bill';
            if (from.includes('electric') || subject.includes('electric')) {
                info.billType = 'electricity';
            } else if (from.includes('gas') || subject.includes('gas')) {
                info.billType = 'gas';
            } else if (from.includes('water') || subject.includes('water')) {
                info.billType = 'water';
            } else if (from.includes('internet') || from.includes('comcast') || from.includes('verizon')) {
                info.billType = 'internet';
            } else if (from.includes('phone') || from.includes('mobile')) {
                info.billType = 'phone';
            }

            const dueDateMatch = body.match(/due\s+(?:date|by)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
            if (dueDateMatch) {
                info.dueDate = dueDateMatch[1];
            }
        }

        // Subscriptions
        if (listType === 'Subscriptions') {
            info.type = 'subscription';
            if (from.includes('netflix')) info.service = 'Netflix';
            else if (from.includes('spotify')) info.service = 'Spotify';
            else if (from.includes('hulu')) info.service = 'Hulu';
            else if (from.includes('disney')) info.service = 'Disney+';
            else if (from.includes('prime') || from.includes('amazon')) info.service = 'Amazon Prime';
            else if (from.includes('youtube')) info.service = 'YouTube';

            const renewalMatch = body.match(/renew(?:al|s)?\s+(?:date|on)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
            if (renewalMatch) {
                info.renewalDate = renewalMatch[1];
            }
        }

        // Finance
        if (listType === 'Finance') {
            info.type = 'financial_transaction';
            if (subject.includes('deposit')) info.transactionType = 'deposit';
            else if (subject.includes('withdrawal')) info.transactionType = 'withdrawal';
            else if (subject.includes('transfer')) info.transactionType = 'transfer';
            else if (subject.includes('payment')) info.transactionType = 'payment';

            if (from.includes('paypal')) info.provider = 'PayPal';
            else if (from.includes('venmo')) info.provider = 'Venmo';
            else if (from.includes('stripe')) info.provider = 'Stripe';
            else if (from.includes('bank')) info.provider = 'Bank';
        }

        // Health
        if (listType === 'Health') {
            info.type = 'health';
            if (subject.includes('appointment')) {
                info.healthType = 'appointment';
                const apptMatch = body.match(/appointment\s+(?:on|for)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
                if (apptMatch) {
                    info.appointmentDate = apptMatch[1];
                }
            } else if (subject.includes('prescription')) {
                info.healthType = 'prescription';
            } else if (subject.includes('test result')) {
                info.healthType = 'test_result';
            }
        }

        // Work
        if (listType === 'Work') {
            info.type = 'work';
            if (subject.includes('meeting')) {
                info.workType = 'meeting';
            } else if (subject.includes('task')) {
                info.workType = 'task';
            } else if (subject.includes('reminder')) {
                info.workType = 'reminder';
            }
        }

        // Education
        if (listType === 'Education') {
            info.type = 'education';
            if (subject.includes('assignment')) info.educationType = 'assignment';
            else if (subject.includes('grade')) info.educationType = 'grade';
            else if (subject.includes('course')) info.educationType = 'course';
            else if (subject.includes('class')) info.educationType = 'class';
        }

        // Events (FIX #3: Extract event information - ENHANCED)
        if (listType === 'Events') {
            info.type = 'event';

            // Extract event name from subject or body with multiple patterns
            const eventNamePatterns = [
                /(?:event|show|concert|game|performance):\s*([^\n]+)/i,
                /(?:you're going to|attending|tickets for):\s*([^\n]+)/i,
                /(?:^|\n)([A-Z][^\n]{10,80})(?:\s*-\s*ticket|confirmation)/i
            ];

            for (const pattern of eventNamePatterns) {
                const eventNameMatch = originalSubject.match(pattern) || originalBody.match(pattern);
                if (eventNameMatch) {
                    info.eventName = eventNameMatch[1].trim();
                    break;
                }
            }

            // Use subject as event name if no specific pattern found
            if (!info.eventName) {
                info.eventName = originalSubject.replace(/(?:ticket|confirmation|receipt|order).*$/i, '').trim();
            }

            // Enhanced event type determination with more categories
            if (subject.includes('concert') || body.includes('concert') || body.includes('music') || body.includes('band') || body.includes('tour')) {
                info.eventType = 'concert';
            } else if (subject.includes('theater') || subject.includes('theatre') || body.includes('theater') || body.includes('theatre') ||
                body.includes('play') || body.includes('musical') || body.includes('broadway')) {
                info.eventType = 'theater';
            } else if (subject.includes('comedy') || body.includes('comedy') || body.includes('stand-up') || body.includes('comedian')) {
                info.eventType = 'comedy show';
            } else if (subject.includes('game') || subject.includes('sport') || body.includes('game') || body.includes('sport') ||
                body.includes('match') || body.includes('tournament') || body.includes('championship')) {
                info.eventType = 'spectating sports event';
            } else if (subject.includes('birthday') || body.includes('birthday') || body.includes('bday')) {
                info.eventType = 'birthday party';
            } else if (subject.includes('wedding') || body.includes('wedding') || body.includes('reception')) {
                info.eventType = 'wedding';
            } else if (subject.includes('amusement park') || body.includes('amusement park') || body.includes('theme park') ||
                body.includes('disneyland') || body.includes('universal studios') || body.includes('six flags')) {
                info.eventType = 'amusement park';
            } else if (subject.includes('festival') || body.includes('festival') || body.includes('fair') || body.includes('parade')) {
                info.eventType = 'community event';
            } else if (subject.includes('networking') || body.includes('networking') || body.includes('conference') ||
                body.includes('meetup') || body.includes('seminar') || body.includes('workshop')) {
                info.eventType = 'networking event';
            } else if (subject.includes('exhibition') || body.includes('exhibition') || body.includes('expo') || body.includes('trade show')) {
                info.eventType = 'exhibition';
            } else if (subject.includes('movie') || body.includes('movie') || body.includes('film screening')) {
                info.eventType = 'movie screening';
            } else if (subject.includes('opera') || body.includes('opera') || body.includes('ballet') || body.includes('symphony')) {
                info.eventType = 'performing arts';
            } else if (subject.includes('dinner') || body.includes('dinner party') || body.includes('gala')) {
                info.eventType = 'dinner party';
            } else if (subject.includes('graduation') || body.includes('graduation') || body.includes('commencement')) {
                info.eventType = 'graduation';
            } else {
                info.eventType = 'casual get together';
            }

            // Enhanced venue/location extraction with multiple patterns
            const venuePatterns = [
                /(?:venue|location|at):\s*([^\n]+)/i,
                /(?:held at|taking place at):\s*([^\n]+)/i,
                /([A-Z][a-zA-Z\s&'-]+(?:Arena|Stadium|Theater|Theatre|Hall|Center|Centre|Auditorium|Pavilion))/
            ];

            for (const pattern of venuePatterns) {
                const venueMatch = originalBody.match(pattern);
                if (venueMatch) {
                    info.location = venueMatch[1].trim();
                    break;
                }
            }

            // Extract event date and time with more patterns
            const eventDatePatterns = [
                /(?:event date|date|when):\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i,
                /(?:on|scheduled for):\s*([A-Z][a-z]+,\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i,
                /(\d{1,2}\/\d{1,2}\/\d{4})/
            ];

            for (const pattern of eventDatePatterns) {
                const eventDateMatch = originalBody.match(pattern);
                if (eventDateMatch) {
                    info.eventDate = eventDateMatch[1];
                    break;
                }
            }

            const eventTimePatterns = [
                /(?:event time|time|doors open|starts at):\s*(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?)/i,
                /(\d{1,2}:\d{2}\s*(?:am|pm|AM|PM))/i
            ];

            for (const pattern of eventTimePatterns) {
                const eventTimeMatch = originalBody.match(pattern);
                if (eventTimeMatch) {
                    info.eventTime = eventTimeMatch[1];
                    break;
                }
            }

            // Enhanced ticket provider detection (expanded list)
            if (from.includes('ticketmaster')) info.provider = 'Ticketmaster';
            else if (from.includes('eventbrite')) info.provider = 'Eventbrite';
            else if (from.includes('stubhub')) info.provider = 'StubHub';
            else if (from.includes('seatgeek')) info.provider = 'SeatGeek';
            else if (from.includes('livenation')) info.provider = 'Live Nation';
            else if (from.includes('axs')) info.provider = 'AXS';
            else if (from.includes('ticketweb')) info.provider = 'TicketWeb';
            else if (from.includes('etix')) info.provider = 'Etix';
            else if (from.includes('universe')) info.provider = 'Universe';
            else if (from.includes('viagogo')) info.provider = 'Viagogo';
            else if (from.includes('ticketfly')) info.provider = 'Ticketfly';
            else if (from.includes('brownpapertickets')) info.provider = 'Brown Paper Tickets';
            else if (from.includes('ticketleap')) info.provider = 'Ticketleap';
            else if (from.includes('showclix')) info.provider = 'ShowClix';
            else if (from.includes('ticketnetwork')) info.provider = 'Ticket Network';

            // Extract ticket/order number with multiple patterns
            const ticketPatterns = [
                /(?:ticket|order|confirmation)\s*(?:number|#|no\.?)?\s*:?\s*([a-zA-Z0-9-]+)/i,
                /(?:barcode|reference):\s*([a-zA-Z0-9-]+)/i
            ];

            for (const pattern of ticketPatterns) {
                const ticketMatch = body.match(pattern);
                if (ticketMatch) {
                    info.ticketNumber = ticketMatch[1];
                    break;
                }
            }

            // Extract number of tickets
            const ticketCountMatch = body.match(/(\d+)\s*ticket(?:s)?/i);
            if (ticketCountMatch) {
                info.ticketCount = parseInt(ticketCountMatch[1]);
            }

            // Extract seat information
            const seatPatterns = [
                /(?:seat|section):\s*([^\n]+)/i,
                /(?:row|seat number):\s*([A-Z0-9-]+)/i
            ];

            for (const pattern of seatPatterns) {
                const seatMatch = originalBody.match(pattern);
                if (seatMatch) {
                    info.seatInfo = seatMatch[1].trim();
                    break;
                }
            }
        }

        return info;
    }

    /**
     * Categorize emails into different types based on sender and content
     */
    private categorizeEmails(emails: EmailData[]): Record<string, EmailData[]> {
        const categories: Record<string, EmailData[]> = {
            travel: [],
            food: [],
            shopping: [],
            transport: [],
            bills: [],
            subscriptions: [],
            social: [],
            work: [],
            finance: [],
            health: [],
            education: [],
            events: [],
            other: []
        };

        for (const email of emails) {
            const category = this.determineEmailCategory(email);
            categories[category].push(email);
        }

        return categories;
    }

    /**
     * Determine the category of an email based on sender, subject, and content
     */
    private determineEmailCategory(email: EmailData): string {
        const from = email.from.toLowerCase();
        const subject = email.subject.toLowerCase();
        const body = email.body.toLowerCase();

        // Travel
        if (this.matchesPatterns(from, [
            'booking.com', 'expedia.com', 'airbnb.com', 'hotels.com', 'kayak.com',
            'priceline.com', 'tripadvisor.com', 'delta.com', 'united.com',
            'american.com', 'southwest.com', 'jetblue.com', 'spirit.com'
        ]) || this.matchesPatterns(subject, ['flight', 'hotel', 'booking', 'reservation', 'itinerary'])) {
            return 'travel';
        }

        // Food & Dining
        if (this.matchesPatterns(from, [
            'doordash.com', 'ubereats.com', 'grubhub.com', 'postmates.com',
            'seamless.com', 'opentable.com', 'resy.com', 'yelp.com', 'zomato.com'
        ]) || this.matchesPatterns(subject, ['food delivery', 'restaurant', 'order confirmed'])) {
            return 'food';
        }

        // Shopping
        if (this.matchesPatterns(from, [
            'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com',
            'bestbuy.com', 'apple.com', 'shopify.com', 'aliexpress.com'
        ]) && this.matchesPatterns(subject, ['order', 'purchase', 'receipt', 'confirmation', 'shipped'])) {
            return 'shopping';
        }

        // Transport
        if (this.matchesPatterns(from, [
            'uber.com', 'lyft.com', 'zipcar.com', 'car2go.com', 'lime.com',
            'bird.com', 'metro.com', 'bart.gov', 'mta.info'
        ])) {
            return 'transport';
        }

        // Bills & Utilities
        if (this.matchesPatterns(subject, ['bill', 'invoice', 'payment due', 'statement']) ||
            this.matchesPatterns(from, ['billing', 'invoice', 'utility', 'electric', 'gas', 'water', 'internet', 'phone'])) {
            return 'bills';
        }

        // Subscriptions
        if (this.matchesPatterns(subject, ['subscription', 'membership', 'renewal', 'auto-renew']) ||
            this.matchesPatterns(from, ['netflix.com', 'spotify.com', 'hulu.com', 'disney', 'prime', 'youtube'])) {
            return 'subscriptions';
        }

        // Social Media
        if (this.matchesPatterns(from, [
            'facebook.com', 'twitter.com', 'instagram.com', 'linkedin.com',
            'tiktok.com', 'snapchat.com', 'reddit.com', 'pinterest.com'
        ])) {
            return 'social';
        }

        // Work/Professional
        if (this.matchesPatterns(from, ['slack.com', 'teams.microsoft.com', 'zoom.us', 'meet.google.com']) ||
            this.matchesPatterns(subject, ['meeting', 'calendar', 'reminder', 'task'])) {
            return 'work';
        }

        // Finance
        if (this.matchesPatterns(from, ['bank', 'paypal.com', 'venmo.com', 'stripe.com', 'square.com']) ||
            this.matchesPatterns(subject, ['transaction', 'payment', 'transfer', 'deposit', 'withdrawal'])) {
            return 'finance';
        }

        // Health
        if (this.matchesPatterns(from, ['health', 'medical', 'doctor', 'hospital', 'pharmacy', 'cvs.com', 'walgreens.com']) ||
            this.matchesPatterns(subject, ['appointment', 'prescription', 'health'])) {
            return 'health';
        }

        // Education
        if (this.matchesPatterns(from, ['edu', 'university', 'college', 'school', 'coursera.com', 'udemy.com']) ||
            this.matchesPatterns(subject, ['course', 'class', 'assignment', 'grade'])) {
            return 'education';
        }

        // Events (FIX #3: Add event ticket detection)
        if (this.matchesPatterns(from, [
            'ticketmaster.com', 'eventbrite.com', 'stubhub.com', 'seatgeek.com',
            'livenation.com', 'axs.com', 'ticketweb.com', 'etix.com', 'universe.com'
        ]) || this.matchesPatterns(subject, ['ticket', 'event', 'concert', 'show', 'game', 'festival', 'admission'])) {
            return 'events';
        }

        return 'other';
    }

    /**
     * Check if text matches any of the patterns
     */
    private matchesPatterns(text: string, patterns: string[]): boolean {
        return patterns.some(pattern => text.includes(pattern));
    }

    /**
     * Get category information for list creation
     * FIX #1: Route emails to appropriate lists instead of generic "Email" list
     */
    private getCategoryInfo(category: string): { listType: string; categoryName: string } {
        const categoryMap: Record<string, { listType: string; categoryName: string }> = {
            travel: { listType: 'Travel', categoryName: 'Travel & Bookings' },
            food: { listType: 'Food', categoryName: 'Food & Dining' },
            shopping: { listType: 'Places', categoryName: 'Online Purchases' },
            transport: { listType: 'Transport', categoryName: 'Transportation' },
            bills: { listType: 'Email', categoryName: 'Bills & Utilities' },
            subscriptions: { listType: 'Email', categoryName: 'Subscriptions & Memberships' },
            social: { listType: 'Email', categoryName: 'Social Media' },
            work: { listType: 'Email', categoryName: 'Work & Professional' },
            finance: { listType: 'Email', categoryName: 'Financial Transactions' },
            health: { listType: 'Health', categoryName: 'Health & Medical' },
            education: { listType: 'Email', categoryName: 'Education & Learning' },
            events: { listType: 'Events', categoryName: 'Event Tickets' },
            other: { listType: 'Email', categoryName: 'Other Emails' }
        };

        return categoryMap[category] || categoryMap.other;
    }

    async disconnect(userId: string): Promise<void> {
        this.logger.log(`Disconnecting Email Scraper (Gmail) for user ${userId}`);

        try {
            // Get the access token before deletion
            const tokens = await this.tokens.get(userId, 'email_scraper');

            if (tokens?.accessToken) {
                // Revoke the token with Google
                try {
                    await axios.post('https://oauth2.googleapis.com/revoke', null, {
                        params: {
                            token: tokens.accessToken,
                        },
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                    });
                    this.logger.log(`Successfully revoked Gmail token for user ${userId}`);
                } catch (error) {
                    // Log but don't throw - token might already be invalid
                    this.logger.warn(`Failed to revoke Gmail token for user ${userId}:`, error);
                }
            }
        } catch (error) {
            this.logger.error(`Error during Email Scraper disconnect for user ${userId}:`, error);
            // Don't throw - allow disconnect to continue even if revocation fails
        }

        this.logger.log(`Email Scraper disconnect completed for user ${userId}`);
    }
}