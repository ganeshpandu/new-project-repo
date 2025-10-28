import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationProviderName, ConnectResponse, CallbackPayload } from '../types';
import { URLSearchParams } from 'url';
import { IntegrationPersistence } from '../persistence';
import { PrismaService } from '@traeta/prisma';
import { TokenStore } from '../token-store';
import axios from 'axios';
import {
    ConfigurationException,
    InvalidCallbackException,
    OAuthAuthenticationException,
    InvalidTokenException,
    RefreshTokenException,
    DataSyncException,
    ProviderAPIException,
    RateLimitException,
} from '../exceptions/integration.exceptions';
import { DATA_TYPE, REC_SEQ, STATUS } from '../../../constants';

@Injectable()
export class StravaProvider implements IntegrationProvider {
    public readonly name = IntegrationProviderName.STRAVA;
    private readonly logger = new Logger(StravaProvider.name);

    constructor(
        private readonly db: PrismaService,
        private readonly persistence: IntegrationPersistence,
        private readonly tokens: TokenStore,
        private readonly configService: ConfigService,
    ) { }

    private getClientId(): string {
        return this.configService.get<string>('STRAVA_CLIENT_ID') || '';
    }

    private getClientSecret(): string {
        return this.configService.get<string>('STRAVA_CLIENT_SECRET') || '';
    }

    private getRedirectUri(): string {
        return this.configService.get<string>('STRAVA_REDIRECT_URI') || '';
    }

    private getDefaultDays(): number {
        const days = this.configService.get<string>('STRAVA_DEFAULT_DAYS');
        return days ? Number(days) : 90;
    }

    async createConnection(userId: string): Promise<ConnectResponse> {
        // Validate configuration
        const clientId = this.getClientId();
        const clientSecret = this.getClientSecret();
        const redirectUri = this.getRedirectUri();

        if (!clientId || !clientSecret || !redirectUri) {
            throw new ConfigurationException(
                IntegrationProviderName.STRAVA,
                'Strava integration is not properly configured. Missing CLIENT_ID, CLIENT_SECRET, or REDIRECT_URI.'
            );
        }

        const state = `strava-${userId}-${Date.now()}`;
        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            redirect_uri: redirectUri,
            scope: 'read,activity:read_all',
            state,
            approval_prompt: 'auto',
        });
        const redirectUrl = `https://www.strava.com/oauth/authorize?${params.toString()}`;
        // Ensure Integration row exists early for consistent status queries
        await this.persistence.ensureIntegration('strava');
        return { provider: this.name, redirectUrl, state };
    }

    async handleCallback(payload: CallbackPayload): Promise<void> {
        this.logger.log(`Strava callback received`);
        const { code, state, error } = payload;

        if (error) {
            this.logger.error(`Strava callback error: ${error}`);
            throw new OAuthAuthenticationException(
                IntegrationProviderName.STRAVA,
                `OAuth error: ${error}`
            );
        }

        if (!code || !state) {
            throw new InvalidCallbackException(
                IntegrationProviderName.STRAVA,
                'Missing authorization code or state parameter'
            );
        }

        const stateStr = String(state);
        const prefix = `${this.name}-`;
        if (!stateStr.startsWith(prefix)) {
            throw new InvalidCallbackException(
                IntegrationProviderName.STRAVA,
                `Invalid state prefix: expected '${prefix}', got '${stateStr.split('-')[0]}-'`
            );
        }

        const statePayload = stateStr.slice(prefix.length);
        const lastHyphenIndex = statePayload.lastIndexOf('-');
        if (lastHyphenIndex === -1) {
            throw new InvalidCallbackException(
                IntegrationProviderName.STRAVA,
                'Invalid state format: missing timestamp'
            );
        }

        const userId = statePayload.slice(0, lastHyphenIndex);
        if (!userId) {
            throw new InvalidCallbackException(
                IntegrationProviderName.STRAVA,
                'Missing userId in state parameter'
            );
        }

        try {
            // Exchange code for tokens
            const tokenUrl = 'https://www.strava.com/oauth/token';
            const clientId = this.getClientId();
            const clientSecret = this.getClientSecret();
            const redirectUri = this.getRedirectUri();
            const body = new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                grant_type: 'authorization_code',
                redirect_uri: redirectUri,
            });
            const res = await axios.post(tokenUrl, body.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const data = res.data as {
                token_type: string;
                access_token: string;
                expires_at: number; // epoch seconds
                expires_in: number;
                refresh_token: string;
                athlete?: { id?: number };
                scope?: string;
            };

            await this.tokens.set(userId, 'strava', {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: data.expires_at,
                scope: data.scope,
                providerUserId: data.athlete?.id ? String(data.athlete.id) : undefined,
            });

            const integration = await this.persistence.ensureIntegration('strava');
            await this.persistence.markConnected(userId, integration.integrationId);

            this.logger.log(`Strava connected successfully for user ${userId}`);

            // Automatically sync user data after successful connection
            try {
                this.logger.log(`Starting automatic sync for user ${userId} after Strava connection`);
                const syncResult = await this.sync(userId);
                this.logger.log(`Automatic sync completed for user ${userId}:`, syncResult);
            } catch (syncError) {
                this.logger.error(`Automatic sync failed for user ${userId}:`, syncError);
                // Don't throw error here as connection was successful, sync can be retried later
            }

        } catch (error) {
            this.logger.error(`Failed to handle Strava callback for user ${userId}:`, error);

            // If it's already one of our custom exceptions, re-throw it
            if (error instanceof InvalidCallbackException ||
                error instanceof OAuthAuthenticationException) {
                throw error;
            }

            // Handle Axios errors from Strava API
            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const message = error.response?.data?.message || error.message;

                if (status === 401 || status === 403) {
                    throw new OAuthAuthenticationException(
                        IntegrationProviderName.STRAVA,
                        `Failed to exchange authorization code: ${message}`
                    );
                } else if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.STRAVA,
                        error.response?.headers['retry-after']
                    );
                } else {
                    throw new ProviderAPIException(
                        IntegrationProviderName.STRAVA,
                        'Token exchange',
                        status ? `HTTP ${status}: ${message}` : message
                    );
                }
            }

            // Generic error
            throw new OAuthAuthenticationException(
                IntegrationProviderName.STRAVA,
                `Unexpected error during callback: ${error.message}`
            );
        }
    }

    private async ensureValidAccessToken(userId: string): Promise<string> {
        const existing = await this.tokens.get(userId, 'strava');
        if (!existing) {
            throw new InvalidTokenException(
                IntegrationProviderName.STRAVA
            );
        }

        const now = Math.floor(Date.now() / 1000);
        if (existing.expiresAt && existing.expiresAt - now > 60) {
            return existing.accessToken; // still valid
        }

        if (!existing.refreshToken) {
            throw new InvalidTokenException(
                IntegrationProviderName.STRAVA
            );
        }

        // Refresh
        try {
            const tokenUrl = 'https://www.strava.com/oauth/token';
            const clientId = this.getClientId();
            const clientSecret = this.getClientSecret();
            const body = new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'refresh_token',
                refresh_token: existing.refreshToken,
            });
            const res = await axios.post(tokenUrl, body.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            const data = res.data as {
                access_token: string;
                refresh_token: string;
                expires_at: number;
                scope?: string;
            };

            await this.tokens.set(userId, 'strava', {
                accessToken: data.access_token,
                refreshToken: data.refresh_token,
                expiresAt: data.expires_at,
                scope: data.scope ?? existing.scope,
            });
            return data.access_token;
        } catch (error) {
            this.logger.error(`Failed to refresh Strava token for user ${userId}:`, error);

            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const message = error.response?.data?.message || error.message;

                if (status === 400 || status === 401) {
                    throw new RefreshTokenException(
                        IntegrationProviderName.STRAVA
                    );
                } else if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.STRAVA,
                        error.response?.headers['retry-after']
                    );
                } else {
                    throw new ProviderAPIException(
                        IntegrationProviderName.STRAVA,
                        'Token refresh',
                        status ? `HTTP ${status}: ${message}` : message
                    );
                }
            }

            throw new RefreshTokenException(
                IntegrationProviderName.STRAVA
            );
        }
    }

    async sync(userId: string): Promise<{ ok: boolean; syncedAt?: Date; details?: any }> {
        const integration = await this.persistence.ensureIntegration('strava');
        const defaultDays = this.getDefaultDays();
        const sinceDate =
            (await this.persistence.getLastSyncedAt(userId, integration.integrationId)) ??
            new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);
        const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);

        try {
            const accessToken = await this.ensureValidAccessToken(userId);

            // Fetch activities from Strava since last sync
            const activitiesRes = await axios.get('https://www.strava.com/api/v3/athlete/activities', {
                params: { after: sinceEpoch, per_page: 100, page: 1 },
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            const rawActivities = activitiesRes.data as any[];

            const activities = rawActivities.map((a) => {
                // Map Strava activity to our internal structure
                const start = new Date(a.start_date);
                const movingSeconds = a.moving_time ?? 0;
                const end = new Date(start.getTime() + movingSeconds * 1000);
                const type = (a.sport_type || a.type || 'Other') as string;
                const miles = typeof a.distance === 'number' ? a.distance / 1609.344 : undefined; // meters -> miles
                const yards = type.toLowerCase() === 'swim' && typeof a.distance === 'number' ? a.distance * 1.09361 : undefined; // meters -> yards
                return {
                    id: String(a.id),
                    type,
                    start,
                    end,
                    durationMin: Math.round(movingSeconds / 60),
                    miles,
                    yards,
                    images: [],
                    route: a.map || null,
                };
            });

            const createdItems: Array<{
                id: string;
                type: string;
                start: Date;
                end: Date;
                durationMin: number;
                miles: number | undefined;
                yards: number | undefined;
                images: any[];
                route: any;
                category: string;
                listItemId: string | undefined;
            }> = [];

            for (const a of activities) {
                const categoryName = this.mapType(a.type);
                const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Activity', categoryName);
                const listItem = await this.persistence.createListItem(
                    list.listId,
                    list.recSeq,
                    userList.userListId,
                    userList.recSeq,
                    category?.listCategoryId ?? null,
                    category?.recSeq ?? null,
                    `${categoryName} | ${a.start.toISOString()} - ${a.end.toISOString()}`,
                    {
                        startTime: a.start.toISOString(),
                        endTime: a.end.toISOString(),
                        durationMinutes: a.durationMin,
                        miles: a.miles ?? null,
                        yards: a.yards ?? null,
                        images: a.images ?? [],
                        route: a.route ?? null,
                        external: { provider: 'strava', id: a.id },
                    },
                    {
                        startTime: DATA_TYPE.STRING,
                        endTime: DATA_TYPE.STRING,
                        durationMinutes: DATA_TYPE.NUMBER,
                        miles: DATA_TYPE.NUMBER,
                        yards: DATA_TYPE.NUMBER,
                        images: DATA_TYPE.STRING_ARRAY,
                        route: DATA_TYPE.STRING,
                        external: { provider: DATA_TYPE.STRING, id: DATA_TYPE.STRING },
                    }
                );
                createdItems.push({
                    ...a,
                    category: categoryName,
                    listItemId: listItem?.listItemId,
                });
            }

            const link = await this.db.userIntegrations.findFirst({
                where: {
                    userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    integrationId: integration.integrationId,
                    integrationRecSeq: REC_SEQ.DEFAULT_RECORD,
                },
            });

            if (link) await this.persistence.markSynced(link.userIntegrationId);

            return {
                ok: true,
                syncedAt: new Date(),
                details: {
                    activitiesCount: activities.length,
                    since: sinceDate,
                    activities: createdItems,
                    rawStravaData: rawActivities
                }
            };

        } catch (error) {
            this.logger.error(`Strava sync failed for user ${userId}:`, error);

            // If it's already one of our custom exceptions, re-throw it
            if (error instanceof InvalidTokenException ||
                error instanceof RefreshTokenException ||
                error instanceof RateLimitException ||
                error instanceof ProviderAPIException) {
                throw error;
            }

            // Handle Axios errors from Strava API
            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const message = error.response?.data?.message || error.message;

                if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.STRAVA,
                        error.response?.headers['retry-after']
                    );
                } else if (status === 401 || status === 403) {
                    throw new InvalidTokenException(
                        IntegrationProviderName.STRAVA
                    );
                } else {
                    throw new ProviderAPIException(
                        IntegrationProviderName.STRAVA,
                        'sync',
                        status ? `HTTP ${status}: ${message}` : message
                    );
                }
            }

            // Generic sync error
            throw new DataSyncException(
                IntegrationProviderName.STRAVA,
                `Failed to sync Strava data: ${error.message}`
            );
        }
    }

    async status(userId: string): Promise<{ connected: boolean; lastSyncedAt?: Date | null; details?: any }> {
        const integration = await this.persistence.ensureIntegration('strava');
        const link = await this.db.userIntegrations.findFirst({
            where: {
                userId,
                userRecSeq: REC_SEQ.DEFAULT_RECORD,
                integrationId: integration.integrationId,
                integrationRecSeq: REC_SEQ.DEFAULT_RECORD,
            },
        });

        const history = link
            ? await this.db.userIntegrationHistory.findFirst({
                where: {
                    userIntegrationId: link.userIntegrationId,
                    userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD,
                },
            })
            : null;

        return {
            connected: !!link && link.status === STATUS.CONNECTED,
            lastSyncedAt: history?.lastSyncedAt ?? null,
            details: {
                integrationId: integration.integrationId,
                popularity: integration.popularity
            }
        };
    }

    private mapType(t: string): string {
        switch ((t || '').toLowerCase()) {
            case 'run':
                return 'Run';
            case 'ride':
            case 'bike':
                return 'Bike';
            case 'swim':
                return 'Swim';
            case 'walk':
                return 'Walk';
            case 'hike':
                return 'Hike';
            case 'workout':
            case 'strength':
                return 'Strength';
            default:
                return 'Other';
        }
    }

    async disconnect(userId: string): Promise<void> {
        this.logger.log(`Disconnecting Strava for user ${userId}`);

        try {
            // Get the access token before deletion
            const tokens = await this.tokens.get(userId, 'strava');

            if (tokens?.accessToken) {
                // Revoke the token with Strava
                // Strava provides a deauthorization endpoint
                try {
                    await axios.post('https://www.strava.com/oauth/deauthorize', null, {
                        headers: {
                            'Authorization': `Bearer ${tokens.accessToken}`,
                        },
                    });
                    this.logger.log(`Successfully revoked Strava token for user ${userId}`);
                } catch (error) {
                    // Log but don't throw - token might already be invalid
                    this.logger.warn(`Failed to revoke Strava token for user ${userId}:`, error);
                }
            }
        } catch (error) {
            this.logger.error(`Error during Strava disconnect for user ${userId}:`, error);
            // Don't throw - allow disconnect to continue even if revocation fails
        }

        this.logger.log(`Strava disconnect completed for user ${userId}`);
    }
}