import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { IntegrationProvider, IntegrationProviderName, ConnectResponse, CallbackPayload } from './types';
import { PlaidProvider } from './providers/plaid.provider';
import { StravaProvider } from './providers/strava.provider';
import { AppleHealthProvider } from './providers/apple-health.provider';
import { AppleMusicProvider } from './providers/apple-music.provider';
import { SpotifyProvider } from './providers/spotify.provider';
import { EmailScraperProvider } from './providers/email-scraper.provider';
import { LocationServicesProvider } from './providers/location-services.provider';
import { ContactListProvider } from './providers/contact-list.provider';
import { GoodreadsProvider } from './providers/goodreads.provider';
import { PrismaService } from '@traeta/prisma';
import { IntegrationPersistence } from './persistence';
import { TokenStore } from './token-store';
import {
    ProviderNotFoundException,
    ProviderNotConnectedException,
    InvalidCallbackException,
    DataSyncException,
    UserDataNotFoundException,
    DataValidationException,
} from './exceptions';
import { DATA_STATUS, REC_SEQ, REC_STATUS } from '../../constants';

@Injectable()
export class IntegrationsService {
    private readonly providers: Map<IntegrationProviderName, IntegrationProvider>;
    private readonly logger = new Logger(IntegrationsService.name);

    constructor(
        private readonly plaid: PlaidProvider,
        private readonly strava: StravaProvider,
        private readonly appleHealth: AppleHealthProvider,
        private readonly appleMusic: AppleMusicProvider,
        private readonly spotify: SpotifyProvider,
        private readonly emailScraper: EmailScraperProvider,
        private readonly locationServices: LocationServicesProvider,
        private readonly contactList: ContactListProvider,
        private readonly goodreads: GoodreadsProvider,
        private readonly prisma: PrismaService,
        private readonly persistence: IntegrationPersistence,
        private readonly tokenStore: TokenStore,
    ) {
        this.providers = new Map<IntegrationProviderName, IntegrationProvider>([
            [plaid.name, plaid],
            [strava.name, strava],
            [appleHealth.name, appleHealth],
            [appleMusic.name, appleMusic],
            [spotify.name, spotify],
            [emailScraper.name, emailScraper],
            [locationServices.name, locationServices],
            [contactList.name, contactList],
            [goodreads.name, goodreads],
        ]);
    }

    private getProviderOrThrow(name: IntegrationProviderName): IntegrationProvider {
        const p = this.providers.get(name);
        if (!p) {
            this.logger.error(`Provider not found: ${name}`);
            throw new ProviderNotFoundException(name);
        }
        return p;
    }

    async createConnection(provider: IntegrationProviderName, userId: string): Promise<ConnectResponse> {
        try {
            this.logger.log(`Creating connection for provider: ${provider}, userId: ${userId}`);
            const response = await this.getProviderOrThrow(provider).createConnection(userId);
            // Ensure provider is included in the response
            return {
                ...response,
                provider: provider,
            };
        } catch (error) {
            this.logger.error(`Failed to create connection for ${provider}:`, error);
            throw error;
        }
    }

    async handleCallback(provider: IntegrationProviderName, payload: CallbackPayload): Promise<void> {
        try {
            this.logger.log(`Handling callback for provider: ${provider}`);

            // Validate callback payload
            if (payload.error) {
                throw new InvalidCallbackException(
                    provider,
                    `OAuth error: ${payload.error}${payload.error_description ? ` - ${payload.error_description}` : ''}`
                );
            }

            if (!payload.code && !payload.music_user_token) {
                throw new InvalidCallbackException(provider, 'Missing authorization code or token');
            }

            return await this.getProviderOrThrow(provider).handleCallback(payload);
        } catch (error) {
            this.logger.error(`Failed to handle callback for ${provider}:`, error);
            throw error;
        }
    }

    async handleCallbackWithUserData(provider: IntegrationProviderName, payload: CallbackPayload): Promise<any> {
        try {
            this.logger.log(`Handling callback with user data for provider: ${provider}`);

            // Handle the callback first
            await this.handleCallback(provider, payload);

            // Extract userId from state for Spotify, Strava, Plaid, Apple Music, and Email Scraper
            if ((provider === IntegrationProviderName.SPOTIFY || provider === IntegrationProviderName.STRAVA || provider === IntegrationProviderName.PLAID || provider === IntegrationProviderName.APPLE_MUSIC || provider === IntegrationProviderName.EMAIL_SCRAPER) && payload.state) {
                const stateStr = String(payload.state);
                let prefix = `${provider}-`;

                // Handle email scraper special case (state format: "email-<userId>-<timestamp>")
                if (provider === IntegrationProviderName.EMAIL_SCRAPER) {
                    prefix = 'email-';
                }

                // Handle apple music special case (state format: "apple-music-<userId>-<timestamp>")
                if (provider === IntegrationProviderName.APPLE_MUSIC) {
                    prefix = 'apple-music-';
                }

                if (stateStr.startsWith(prefix)) {
                    const statePayload = stateStr.slice(prefix.length);
                    const lastHyphenIndex = statePayload.lastIndexOf('-');
                    if (lastHyphenIndex !== -1) {
                        const userId = statePayload.slice(0, lastHyphenIndex);
                        if (userId) {
                            // Get user data with integration details and synced content
                            return await this.getUserDataWithSyncedContent(userId, provider);
                        }
                    }
                }
            }

            return { ok: true, message: 'Integration connected successfully' };
        } catch (error) {
            this.logger.error(`Failed to handle callback with user data for ${provider}:`, error);
            throw error;
        }
    }

    private async getUserDataWithSyncedContent(userId: string, provider: IntegrationProviderName): Promise<any> {
        try {
            // Get user information
            const user = await this.prisma.users.findUnique({
                where: {
                    userId_recSeq: {
                        userId: userId,
                        recSeq: REC_SEQ.DEFAULT_RECORD,
                    },
                    recStatus: REC_STATUS.ACTIVE,
                    dataStatus: DATA_STATUS.ACTIVE,
                },
                include: {
                    avatar: {
                        select: {
                            masterDataId: true,
                            keyCode: true,
                            value: true,
                        },
                    },
                },
            });

            if (!user) {
                this.logger.error(`User not found: ${userId}`);
                throw new UserDataNotFoundException(provider, 'user profile');
            }

            // Get integration status
            const integrationStatus = await this.status(provider, userId);

            // Get synced data based on provider
            let syncedData = null;
            if (provider === IntegrationProviderName.SPOTIFY && integrationStatus.connected) {
                syncedData = await this.getSpotifyMusicData(userId);
            } else if (provider === IntegrationProviderName.STRAVA && integrationStatus.connected) {
                syncedData = await this.getStravaActivityData(userId);
            } else if (provider === IntegrationProviderName.PLAID && integrationStatus.connected) {
                syncedData = await this.getPlaidFinancialData(userId);
            } else if (provider === IntegrationProviderName.APPLE_MUSIC && integrationStatus.connected) {
                syncedData = await this.getAppleMusicData(userId);
            } else if (provider === IntegrationProviderName.EMAIL_SCRAPER && integrationStatus.connected) {
                syncedData = await this.getEmailScraperData(userId);
            }

            return {
                ok: true,
                message: 'Integration connected and data synced successfully',
                data: {
                    user: {
                        userId: user.userId,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        username: user.username,
                        email: user.email,
                        phoneNumber: user.phoneNumber,
                        dateOfBirth: user.dateOfBirth,
                        gender: user.gender,
                        avatar: user.avatar,
                        isProfileComplete: user.isProfileComplete,
                        createdAt: user.createdOn,
                        updatedAt: user.modifiedOn,
                    },
                    integration: {
                        provider: provider,
                        connected: integrationStatus.connected,
                        lastSyncedAt: integrationStatus.lastSyncedAt,
                        details: integrationStatus.details,
                    },
                    syncedData: syncedData,
                }
            };
        } finally {
            await this.prisma.$disconnect();
        }
    }

    private async getSpotifyMusicData(userId: string): Promise<any> {
        try {
            // Get user's music lists
            const musicLists = await this.prisma.userLists.findMany({
                where: {
                    userId: userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    recStatus: REC_STATUS.ACTIVE,
                    dataStatus: DATA_STATUS.ACTIVE,
                    list: {
                        name: 'Music',
                        recStatus: REC_STATUS.ACTIVE,
                        dataStatus: DATA_STATUS.ACTIVE,
                    },
                },
                include: {
                    list: {
                        include: {
                            categories: {
                                where: {
                                    recStatus: REC_STATUS.ACTIVE,
                                    dataStatus: DATA_STATUS.ACTIVE,
                                },
                                include: {
                                    items: {
                                        where: {
                                            recStatus: REC_STATUS.ACTIVE,
                                            dataStatus: DATA_STATUS.ACTIVE,
                                        },
                                        orderBy: {
                                            createdOn: 'desc',
                                        },
                                        take: 10, // Limit to recent items
                                    },
                                },
                            },
                        },
                    },
                },
            });

            const musicData: {
                recentlyPlayed: any[];
                likedSongs: any[];
                playlists: any[];
                topTracks: any[];
            } = {
                recentlyPlayed: [],
                likedSongs: [],
                playlists: [],
                topTracks: [],
            };

            for (const userList of musicLists) {
                for (const category of userList.list.categories) {
                    const categoryName = category.name.toLowerCase();
                    const items = category.items.map(item => ({
                        id: item.listItemId,
                        title: item.title,
                        attributes: item.attributes,
                        createdAt: item.createdOn,
                        updatedAt: item.modifiedOn,
                    }));

                    if (categoryName.includes('recently played')) {
                        musicData.recentlyPlayed = items;
                    } else if (categoryName.includes('liked') || categoryName.includes('saved')) {
                        musicData.likedSongs = items;
                    } else if (categoryName.includes('playlist')) {
                        musicData.playlists = items;
                    } else if (categoryName.includes('top')) {
                        musicData.topTracks = items;
                    }
                }
            }

            return musicData;
        } catch (error) {
            console.error('Error fetching Spotify music data:', error);
            return {
                recentlyPlayed: [],
                likedSongs: [],
                playlists: [],
                topTracks: [],
                error: 'Failed to fetch synced music data',
            };
        }
    }

    private async getStravaActivityData(userId: string): Promise<any> {
        try {
            // Get user's activity lists
            const activityLists = await this.prisma.userLists.findMany({
                where: {
                    userId: userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    recStatus: REC_STATUS.ACTIVE,
                    dataStatus: DATA_STATUS.ACTIVE,
                    list: {
                        name: 'Activity',
                        recStatus: REC_STATUS.ACTIVE,
                        dataStatus: DATA_STATUS.ACTIVE,
                    },
                },
                include: {
                    list: {
                        include: {
                            categories: {
                                where: {
                                    recStatus: REC_STATUS.ACTIVE,
                                    dataStatus: DATA_STATUS.ACTIVE,
                                },
                                include: {
                                    items: {
                                        where: {
                                            recStatus: REC_STATUS.ACTIVE,
                                            dataStatus: DATA_STATUS.ACTIVE,
                                        },
                                        orderBy: {
                                            createdOn: 'desc',
                                        },
                                        take: 50, // Limit to recent items
                                    },
                                },
                            },
                        },
                    },
                },
            });

            const activityData: {
                runs: any[];
                bikes: any[];
                swims: any[];
                walks: any[];
                hikes: any[];
                strength: any[];
                other: any[];
                totalActivities: number;
            } = {
                runs: [],
                bikes: [],
                swims: [],
                walks: [],
                hikes: [],
                strength: [],
                other: [],
                totalActivities: 0,
            };

            for (const userList of activityLists) {
                for (const category of userList.list.categories) {
                    const categoryName = category.name.toLowerCase();
                    const items = category.items.map(item => ({
                        id: item.listItemId,
                        title: item.title,
                        attributes: item.attributes,
                        createdAt: item.createdOn,
                        updatedAt: item.modifiedOn,
                    }));

                    activityData.totalActivities += items.length;

                    if (categoryName.includes('run')) {
                        activityData.runs = items;
                    } else if (categoryName.includes('bike') || categoryName.includes('ride')) {
                        activityData.bikes = items;
                    } else if (categoryName.includes('swim')) {
                        activityData.swims = items;
                    } else if (categoryName.includes('walk')) {
                        activityData.walks = items;
                    } else if (categoryName.includes('hike')) {
                        activityData.hikes = items;
                    } else if (categoryName.includes('strength') || categoryName.includes('workout')) {
                        activityData.strength = items;
                    } else {
                        activityData.other = items;
                    }
                }
            }

            return activityData;
        } catch (error) {
            console.error('Error fetching Strava activity data:', error);
            return {
                runs: [],
                bikes: [],
                swims: [],
                walks: [],
                hikes: [],
                strength: [],
                other: [],
                totalActivities: 0,
                error: 'Failed to fetch synced activity data',
            };
        }
    }

    private async getPlaidFinancialData(userId: string): Promise<any> {
        try {
            const financialData: {
                transactions: any[];
                accounts: any[];
                totalTransactions: number;
                totalAccounts: number;
            } = {
                transactions: [],
                accounts: [],
                totalTransactions: 0,
                totalAccounts: 0,
            };

            // Get accounts from Financial list
            const financialLists = await this.prisma.userLists.findMany({
                where: {
                    userId: userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    recStatus: REC_STATUS.ACTIVE,
                    dataStatus: DATA_STATUS.ACTIVE,
                    list: {
                        name: 'Financial',
                        recStatus: REC_STATUS.ACTIVE,
                        dataStatus: DATA_STATUS.ACTIVE,
                    },
                },
                include: {
                    list: {
                        include: {
                            categories: {
                                where: {
                                    recStatus: REC_STATUS.ACTIVE,
                                    dataStatus: DATA_STATUS.ACTIVE,
                                },
                                include: {
                                    items: {
                                        where: {
                                            recStatus: REC_STATUS.ACTIVE,
                                            dataStatus: DATA_STATUS.ACTIVE,
                                        },
                                        orderBy: {
                                            createdOn: 'desc',
                                        },
                                    },
                                },
                            },
                        },
                    },
                },
            });

            // Process accounts from Financial list
            for (const userList of financialLists) {
                for (const category of userList.list.categories) {
                    const categoryName = category.name.toLowerCase();
                    const items = category.items.map(item => ({
                        id: item.listItemId,
                        title: item.title,
                        attributes: item.attributes,
                        createdAt: item.createdOn,
                        updatedAt: item.modifiedOn,
                    }));

                    if (categoryName.includes('account')) {
                        financialData.accounts.push(...items);
                        financialData.totalAccounts += items.length;
                    }
                }
            }

            // Get transactions from categorized lists (Travel, Transport, Food, Places)
            const transactionLists = await this.prisma.userLists.findMany({
                where: {
                    userId: userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    recStatus: REC_STATUS.ACTIVE,
                    dataStatus: DATA_STATUS.ACTIVE,
                    list: {
                        name: {
                            in: ['Travel', 'Transport', 'Food', 'Places'],
                        },
                        recStatus: REC_STATUS.ACTIVE,
                        dataStatus: DATA_STATUS.ACTIVE,
                    },
                },
                include: {
                    list: {
                        include: {
                            categories: {
                                where: {
                                    recStatus: REC_STATUS.ACTIVE,
                                    dataStatus: DATA_STATUS.ACTIVE,
                                },
                                include: {
                                    items: {
                                        where: {
                                            recStatus: REC_STATUS.ACTIVE,
                                            dataStatus: DATA_STATUS.ACTIVE,
                                            // Only get items from Plaid (check external.provider in attributes)
                                        },
                                        orderBy: {
                                            createdOn: 'desc',
                                        },
                                        take: 100, // Limit to recent transactions
                                    },
                                },
                            },
                        },
                    },
                },
            });

            // Process transactions from categorized lists
            for (const userList of transactionLists) {
                for (const category of userList.list.categories) {
                    const items = category.items
                        .filter(item => {
                            // Only include items from Plaid provider
                            const attributes = item.attributes as any;
                            return attributes?.external?.provider === 'plaid' && attributes?.external?.type === 'transaction';
                        })
                        .map(item => ({
                            id: item.listItemId,
                            title: item.title,
                            attributes: item.attributes,
                            createdAt: item.createdOn,
                            updatedAt: item.modifiedOn,
                        }));

                    financialData.transactions.push(...items);
                    financialData.totalTransactions += items.length;
                }
            }

            return financialData;
        } catch (error) {
            console.error('Error fetching Plaid financial data:', error);
            return {
                transactions: [],
                accounts: [],
                totalTransactions: 0,
                totalAccounts: 0,
                error: 'Failed to fetch synced financial data',
            };
        }
    }

    private async getEmailScraperData(userId: string): Promise<any> {
        try {
            const emailData: {
                travel: any[];
                food: any[];
                shopping: any[];
                transport: any[];
                bills: any[];
                subscriptions: any[];
                social: any[];
                work: any[];
                finance: any[];
                health: any[];
                education: any[];
                other: any[];
                totalEmails: number;
            } = {
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
                other: [],
                totalEmails: 0,
            };

            // Get user's email lists
            const emailLists = await this.prisma.userLists.findMany({
                where: {
                    userId: userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    recStatus: REC_STATUS.ACTIVE,
                    dataStatus: DATA_STATUS.ACTIVE,
                    list: {
                        name: 'Email',
                        recStatus: REC_STATUS.ACTIVE,
                        dataStatus: DATA_STATUS.ACTIVE,
                    },
                },
                include: {
                    list: {
                        include: {
                            categories: {
                                where: {
                                    recStatus: REC_STATUS.ACTIVE,
                                    dataStatus: DATA_STATUS.ACTIVE,
                                },
                                include: {
                                    items: {
                                        where: {
                                            recStatus: REC_STATUS.ACTIVE,
                                            dataStatus: DATA_STATUS.ACTIVE,
                                        },
                                        orderBy: {
                                            createdOn: 'desc',
                                        },
                                        take: 100, // Limit to recent items per category
                                    },
                                },
                            },
                        },
                    },
                },
            });

            console.log('[GET EMAIL DATA] Found email lists:', emailLists.length);
            console.log('[GET EMAIL DATA] User ID:', userId);

            for (const userList of emailLists) {
                console.log('[GET EMAIL DATA] Processing list:', userList.list.name);
                console.log('[GET EMAIL DATA] Categories count:', userList.list.categories.length);
                for (const category of userList.list.categories) {
                    const categoryName = category.name.toLowerCase();
                    console.log('[GET EMAIL DATA] Category:', categoryName, 'Items:', category.items.length);
                    const items = category.items.map(item => ({
                        id: item.listItemId,
                        title: item.title,
                        attributes: item.attributes,
                        createdAt: item.createdOn,
                        updatedAt: item.modifiedOn,
                    }));

                    emailData.totalEmails += items.length;

                    // Map categories to the correct keys based on actual category names
                    if (categoryName.includes('travel') || categoryName.includes('booking')) {
                        emailData.travel.push(...items);
                    } else if (categoryName.includes('food') || categoryName.includes('dining')) {
                        emailData.food.push(...items);
                    } else if (categoryName.includes('shopping') || categoryName.includes('purchase')) {
                        emailData.shopping.push(...items);
                    } else if (categoryName.includes('transport')) {
                        emailData.transport.push(...items);
                    } else if (categoryName.includes('bill') || categoryName.includes('utilit')) {
                        emailData.bills.push(...items);
                    } else if (categoryName.includes('subscription') || categoryName.includes('membership')) {
                        emailData.subscriptions.push(...items);
                    } else if (categoryName.includes('social') || categoryName.includes('media')) {
                        emailData.social.push(...items);
                    } else if (categoryName.includes('work') || categoryName.includes('professional')) {
                        emailData.work.push(...items);
                    } else if (categoryName.includes('financ') || categoryName.includes('transaction')) {
                        emailData.finance.push(...items);
                    } else if (categoryName.includes('health') || categoryName.includes('medical')) {
                        emailData.health.push(...items);
                    } else if (categoryName.includes('education') || categoryName.includes('learning')) {
                        emailData.education.push(...items);
                    } else {
                        emailData.other.push(...items);
                    }
                }
            }

            console.log('[GET EMAIL DATA] Final totalEmails:', emailData.totalEmails);
            console.log('[GET EMAIL DATA] Category breakdown:', {
                travel: emailData.travel.length,
                food: emailData.food.length,
                shopping: emailData.shopping.length,
                transport: emailData.transport.length,
                bills: emailData.bills.length,
                subscriptions: emailData.subscriptions.length,
                social: emailData.social.length,
                work: emailData.work.length,
                finance: emailData.finance.length,
                health: emailData.health.length,
                education: emailData.education.length,
                other: emailData.other.length,
            });

            return emailData;
        } catch (error) {
            console.error('Error fetching Email Scraper data:', error);
            return {
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
                other: [],
                totalEmails: 0,
                error: 'Failed to fetch synced email data',
            };
        }
    }

    private async getAppleMusicData(userId: string): Promise<any> {
        try {
            // Get user's music lists
            const musicLists = await this.prisma.userLists.findMany({
                where: {
                    userId: userId,
                    userRecSeq: REC_SEQ.DEFAULT_RECORD,
                    recStatus: REC_STATUS.ACTIVE,
                    dataStatus: DATA_STATUS.ACTIVE,
                    list: {
                        name: 'Music',
                        recStatus: REC_STATUS.ACTIVE,
                        dataStatus: DATA_STATUS.ACTIVE,
                    },
                },
                include: {
                    list: {
                        include: {
                            categories: {
                                where: {
                                    recStatus: REC_STATUS.ACTIVE,
                                    dataStatus: DATA_STATUS.ACTIVE,
                                },
                                include: {
                                    items: {
                                        where: {
                                            recStatus: REC_STATUS.ACTIVE,
                                            dataStatus: DATA_STATUS.ACTIVE,
                                        },
                                        orderBy: {
                                            createdOn: 'desc',
                                        },
                                        take: 50, // Limit to recent items
                                    },
                                },
                            },
                        },
                    },
                },
            });

            const musicData: {
                recentlyPlayed: any[];
                librarySongs: any[];
                playlists: any[];
                totalItems: number;
            } = {
                recentlyPlayed: [],
                librarySongs: [],
                playlists: [],
                totalItems: 0,
            };

            for (const userList of musicLists) {
                for (const category of userList.list.categories) {
                    const categoryName = category.name.toLowerCase();
                    const items = category.items
                        .filter(item => {
                            // Only include items from Apple Music provider
                            const attributes = item.attributes as any;
                            return attributes?.external?.provider === 'apple_music';
                        })
                        .map(item => ({
                            id: item.listItemId,
                            title: item.title,
                            attributes: item.attributes,
                            createdAt: item.createdOn,
                            updatedAt: item.modifiedOn,
                        }));

                    musicData.totalItems += items.length;

                    if (categoryName.includes('recently played') || categoryName.includes('recent')) {
                        musicData.recentlyPlayed.push(...items);
                    } else if (categoryName.includes('library') || categoryName.includes('saved')) {
                        musicData.librarySongs.push(...items);
                    } else if (categoryName.includes('playlist')) {
                        musicData.playlists.push(...items);
                    }
                }
            }

            return musicData;
        } catch (error) {
            console.error('Error fetching Apple Music data:', error);
            return {
                recentlyPlayed: [],
                librarySongs: [],
                playlists: [],
                totalItems: 0,
                error: 'Failed to fetch synced Apple Music data',
            };
        }
    }

    async sync(provider: IntegrationProviderName, userId: string) {
        try {
            this.logger.log(`Syncing data for provider: ${provider}, userId: ${userId}`);
            const result = await this.getProviderOrThrow(provider).sync(userId);

            if (!result.ok) {
                throw new DataSyncException(provider, result.details?.error || 'Sync failed');
            }

            return result;
        } catch (error) {
            this.logger.error(`Failed to sync data for ${provider}:`, error);
            if (error instanceof DataSyncException) {
                throw error;
            }
            throw new DataSyncException(provider, error.message);
        }
    }

    async status(provider: IntegrationProviderName, userId: string) {
        try {
            this.logger.log(`Getting status for provider: ${provider}, userId: ${userId}`);
            return await this.getProviderOrThrow(provider).status(userId);
        } catch (error) {
            this.logger.error(`Failed to get status for ${provider}:`, error);
            throw error;
        }
    }

    /**
     * Formats provider name to readable format by capitalizing and removing underscores
     * Example: 'apple_health' -> 'Apple Health', 'spotify' -> 'Spotify'
     */
    private formatProviderName(provider: string): string {
        return provider
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');
    }

    private mapProviderToList(provider: IntegrationProviderName): string {
        switch (provider) {
            case IntegrationProviderName.SPOTIFY:
            case IntegrationProviderName.APPLE_MUSIC:
                return 'Music';
            case IntegrationProviderName.STRAVA:
                return 'Activity';
            case IntegrationProviderName.PLAID:
                return 'Financial';
            case IntegrationProviderName.EMAIL_SCRAPER:
                return 'Email';
            case IntegrationProviderName.CONTACT_LIST:
                return 'Friends';
            case IntegrationProviderName.APPLE_HEALTH:
                return 'Health';
            case IntegrationProviderName.LOCATION_SERVICES:
                return 'Places';
            case IntegrationProviderName.GOODREADS:
                return 'Books';
            default:
                return this.formatProviderName(provider);
        }
    }

    async getAllStatuses(userId: string) {
        try {
            this.logger.log(`Getting all integration statuses for userId: ${userId}`);

            const statuses: Array<{
                provider: IntegrationProviderName;
                provider_name: string;
                connected: boolean;
                lastSyncedAt: Date | null | undefined;
                popularity?: number;
                details?: any;
                error?: string;
            }> = [];

            // Iterate through all providers and get their status
            for (const [providerName, provider] of this.providers.entries()) {
                try {
                    const status = await provider.status(userId);
                    statuses.push({
                        provider: providerName,
                        provider_name: this.formatProviderName(providerName),
                        connected: status.connected,
                        lastSyncedAt: status.lastSyncedAt,
                        popularity: status.details?.popularity,
                        details: status.details,
                    });
                } catch (error) {
                    // If a provider fails, log the error but continue with other providers
                    this.logger.error(`Failed to get status for ${providerName}:`, error);
                    statuses.push({
                        provider: providerName,
                        provider_name: this.formatProviderName(providerName),
                        connected: false,
                        lastSyncedAt: null,
                        error: error.message || 'Failed to retrieve status',
                    });
                }
            }

            const sortedStatuses = statuses.sort((a, b) => {
                const ap = a.popularity ?? Number.NEGATIVE_INFINITY;
                const bp = b.popularity ?? Number.NEGATIVE_INFINITY;
                return bp - ap;
            });

            const topIntegrations = sortedStatuses.slice(0, 3);
            const remaining = sortedStatuses.slice(3);

            const integrationsByList = remaining.reduce<Record<string, typeof remaining>>((acc, item) => {
                const listName = this.mapProviderToList(item.provider);
                if (!acc[listName]) acc[listName] = [];
                acc[listName].push(item);
                return acc;
            }, {});

            return {
                userId,
                topIntegrations,
                integrationsByList,
                totalIntegrations: sortedStatuses.length,
                connectedIntegrations: sortedStatuses.filter(s => s.connected).length,
            };
            // return {
            //     userId,
            //     integrations: sortedStatuses,
            //     totalIntegrations: sortedStatuses.length,
            //     connectedIntegrations: sortedStatuses.filter(s => s.connected).length,
            // };

        } catch (error) {
            this.logger.error(`Failed to get all statuses for userId ${userId}:`, error);
            throw error;
        }
    }

    // Apple Health specific methods
    async handleAppleHealthUpload(userId: string, uploadToken: string, healthData: any) {
        try {
            this.logger.log(`Handling Apple Health upload for userId: ${userId}`);
            const provider = this.getProviderOrThrow(IntegrationProviderName.APPLE_HEALTH);

            if (!('handleDataUpload' in provider) || typeof provider.handleDataUpload !== 'function') {
                throw new DataValidationException(
                    IntegrationProviderName.APPLE_HEALTH,
                    'Apple Health provider does not support data upload'
                );
            }

            return await (provider as any).handleDataUpload(userId, uploadToken, healthData);
        } catch (error) {
            this.logger.error(`Failed to handle Apple Health upload:`, error);
            throw error;
        }
    }

    // Apple Music specific methods
    async handleAppleMusicAuthorization(userId: string, musicUserToken: string, state?: string) {
        const provider = this.getProviderOrThrow(IntegrationProviderName.APPLE_MUSIC);
        await provider.handleCallback({
            music_user_token: musicUserToken,
            state: state || `apple-music-${userId}-${Date.now()}`,
        });
        return { ok: true, message: 'Apple Music authorized successfully' };
    }

    // Get integration configuration for mobile apps
    async getIntegrationConfig(provider: IntegrationProviderName, userId: string) {
        const providerInstance = this.getProviderOrThrow(provider);

        switch (provider) {
            case IntegrationProviderName.APPLE_HEALTH:
                const appleHealthStatus = await providerInstance.status(userId);
                return {
                    provider: 'apple_health',
                    uploadEndpoint: process.env.APPLE_HEALTH_UPLOAD_ENDPOINT || '/integrations/apple_health/upload',
                    connected: appleHealthStatus.connected,
                    lastSyncedAt: appleHealthStatus.lastSyncedAt,
                    uploadToken: appleHealthStatus.details?.uploadToken, // Include upload token for connected users
                    supportedDataTypes: [
                        'workouts',
                        'healthMetrics',
                        'steps',
                        'heartRate',
                        'sleep'
                    ],
                };

            case IntegrationProviderName.APPLE_MUSIC:
                const appleMusicStatus = await providerInstance.status(userId);
                return {
                    provider: 'apple_music',
                    connected: appleMusicStatus.connected,
                    lastSyncedAt: appleMusicStatus.lastSyncedAt,
                    authorizationUrl: 'https://authorize.music.apple.com/woa',
                    supportedDataTypes: [
                        'recentlyPlayed',
                        'librarySongs',
                        'playlists'
                    ],
                    details: appleMusicStatus.details,
                };

            case IntegrationProviderName.STRAVA:
                const stravaStatus = await providerInstance.status(userId);
                return {
                    provider: 'strava',
                    connected: stravaStatus.connected,
                    lastSyncedAt: stravaStatus.lastSyncedAt,
                    authorizationUrl: 'https://www.strava.com/oauth/authorize',
                    supportedDataTypes: [
                        'activities'
                    ],
                };

            default:
                const status = await providerInstance.status(userId);
                return {
                    provider,
                    connected: status.connected,
                    lastSyncedAt: status.lastSyncedAt,
                    details: status.details,
                };
        }
    }

    /**
     * Get user data for already connected integrations
     * This method checks if the user is connected, optionally syncs fresh data,
     * and returns user information along with synced integration data
     * 
     * @param provider - The integration provider name
     * @param userId - The user ID
     * @param forceSync - Whether to force a fresh sync (default: true)
     * @returns User data with integration status and synced content
     */
    async getConnectedUserData(
        provider: IntegrationProviderName,
        userId: string,
        forceSync: boolean = true
    ): Promise<any> {
        try {
            // Step 1: Check connection status
            const integrationStatus = await this.status(provider, userId);

            if (!integrationStatus.connected) {
                return {
                    ok: false,
                    connected: false,
                    message: `User is not connected to ${provider}. Please connect first.`,
                    data: null,
                };
            }

            // Step 2: Optionally trigger a fresh sync to get latest data
            if (forceSync) {
                try {
                    await this.sync(provider, userId);
                    // Refresh status after sync
                    const updatedStatus = await this.status(provider, userId);
                    integrationStatus.lastSyncedAt = updatedStatus.lastSyncedAt;
                } catch (syncError) {
                    console.error(`Error syncing ${provider} data for user ${userId}:`, syncError);
                    // Continue to return existing data even if sync fails
                }
            }

            // Step 3: Get user data with synced content
            return await this.getUserDataWithSyncedContent(userId, provider);

        } catch (error) {
            console.error(`Error getting connected user data for ${provider}:`, error);
            return {
                ok: false,
                connected: false,
                message: `Failed to fetch data for ${provider}: ${error.message}`,
                error: error.message,
                data: null,
            };
        }
    }

    /**
     * Disconnect a user from a third-party integration provider
     * This method:
     * 1. Deletes OAuth tokens from the token store
     * 2. Updates the UserIntegrations status to 'DISCONNECTED'
     * 3. Optionally calls provider-specific revocation if supported
     * 
     * @param provider - The integration provider name
     * @param userId - The user ID
     * @returns Success status and message
     */
    async disconnect(provider: IntegrationProviderName, userId: string): Promise<{ statusCode: number; connectionStatus: string; message: string }> {
        try {
            this.logger.log(`Disconnecting provider: ${provider}, userId: ${userId}`);

            // Step 1: Check if the integration exists
            const integrationStatus = await this.status(provider, userId);

            if (!integrationStatus.connected) {
                this.logger.warn(`User ${userId} is not connected to ${provider}`);
                return {
                    statusCode: 400,
                    connectionStatus: 'not_connected',
                    message: `Not connected to ${provider}`,
                };
            }

            // Step 2: Call provider-specific disconnect method (if available)
            // This handles token revocation with the third-party service
            const providerInstance = this.providers.get(provider);
            if (providerInstance && typeof providerInstance.disconnect === 'function') {
                try {
                    await providerInstance.disconnect(userId);
                    this.logger.log(`Provider-specific disconnect completed for ${provider}, userId: ${userId}`);
                } catch (error) {
                    this.logger.error(`Provider-specific disconnect failed for ${provider}:`, error);
                    // Continue with disconnection even if provider revocation fails
                }
            } else {
                this.logger.log(`No provider-specific disconnect method for ${provider}`);
            }

            // Step 3: Delete OAuth tokens from token store
            try {
                await this.tokenStore.delete(userId, provider);
                this.logger.log(`Deleted OAuth tokens for ${provider}, userId: ${userId}`);
            } catch (error) {
                this.logger.error(`Failed to delete tokens for ${provider}:`, error);
                // Continue with disconnection even if token deletion fails
            }

            // Step 4: Mark integration as disconnected in database
            await this.persistence.markDisconnected(userId, provider);
            this.logger.log(`Marked integration as disconnected for ${provider}, userId: ${userId}`);

            return {
                statusCode: 200,
                connectionStatus: 'disconnected',
                message: `Successfully disconnected from ${provider}`,
            };
        } catch (error) {
            this.logger.error(`Failed to disconnect from ${provider}:`, error);
            throw error;
        }
    }
}