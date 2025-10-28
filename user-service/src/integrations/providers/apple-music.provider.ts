import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationProviderName, ConnectResponse, CallbackPayload } from '../types';
import { URLSearchParams } from 'url';
import { IntegrationPersistence } from '../persistence';
import { PrismaService } from '@traeta/prisma';
import { TokenStore } from '../token-store';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
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

interface AppleMusicTrack {
    id: string;
    type: string;
    attributes: {
        name: string;
        artistName: string;
        albumName: string;
        durationInMillis: number;
        playParams?: {
            id: string;
            kind: string;
        };
        artwork?: {
            url: string;
            width: number;
            height: number;
        };
        genreNames?: string[];
        releaseDate?: string;
        isrc?: string;
    };
}

interface AppleMusicPlayHistory {
    id: string;
    type: string;
    attributes: {
        playedDate: string;
        track: AppleMusicTrack;
        playDurationMillis?: number;
        endReasonType?: string; // NATURAL_END_OF_TRACK, SKIPPED_FORWARDS, etc.
    };
}

interface AppleMusicLibraryItem {
    id: string;
    type: string;
    attributes: {
        name: string;
        artistName: string;
        albumName?: string;
        dateAdded: string;
        playCount?: number;
        artwork?: {
            url: string;
            width: number;
            height: number;
        };
    };
}

interface AppleMusicPlaylist {
    id: string;
    type: string;
    attributes: {
        name: string;
        description?: {
            standard: string;
        };
        dateAdded: string;
        lastModifiedDate: string;
        isPublic: boolean;
        canEdit: boolean;
        artwork?: {
            url: string;
            width: number;
            height: number;
        };
    };
    relationships?: {
        tracks?: {
            data: AppleMusicTrack[];
        };
    };
}

@Injectable()
export class AppleMusicProvider implements IntegrationProvider {
    public readonly name = IntegrationProviderName.APPLE_MUSIC;
    private readonly logger = new Logger(AppleMusicProvider.name);

    constructor(
        private readonly db: PrismaService,
        private readonly persistence: IntegrationPersistence,
        private readonly tokens: TokenStore,
        private readonly configService: ConfigService,
    ) { }

    private getTeamId(): string {
        return this.configService.get<string>('APPLE_MUSIC_TEAM_ID') || '';
    }

    private getKeyId(): string {
        return this.configService.get<string>('APPLE_MUSIC_KEY_ID') || '';
    }

    private getPrivateKey(): string {
        return this.configService.get<string>('APPLE_MUSIC_PRIVATE_KEY') || '';
    }

    private getMusicUserToken(): string {
        return this.configService.get<string>('APPLE_MUSIC_USER_TOKEN') || '';
    }

    private getDefaultDays(): number {
        const days = this.configService.get<string>('APPLE_MUSIC_DEFAULT_DAYS');
        return days ? Number(days) : 30;
    }

    private getUseMockData(): boolean {
        const value = this.configService.get<string>('APPLE_MUSIC_USE_MOCK_DATA');
        return value === 'true';
    }

    private getCallbackUrl(): string {
        return this.configService.get<string>('APPLE_MUSIC_CALLBACK_URL') || 'myapp://integrations/apple_music/callback';
    }

    async disconnect(userId: string): Promise<void> {
        this.logger.log(`Disconnecting Apple Music for user ${userId}`);

        try {
            // Note: Apple Music doesn't provide a token revocation endpoint
            // Music User Tokens are managed by the user's Apple ID and can only be revoked
            // by the user through their Apple ID settings or by revoking app permissions
            // We delete the token from our token store
            await this.tokens.delete(userId, 'apple-music');
        } catch (error) {
            this.logger.error(`Failed to delete Apple Music token for user ${userId}:`, error);
            throw error;
        }

        this.logger.log(`Apple Music disconnect completed for user ${userId}`);
    }

    async createConnection(userId: string): Promise<ConnectResponse> {
        try {
            // Validate configuration
            const teamId = this.getTeamId();
            const keyId = this.getKeyId();
            const privateKey = this.getPrivateKey();

            if (!teamId || !keyId || !privateKey) {
                throw new ConfigurationException(
                    IntegrationProviderName.APPLE_MUSIC,
                    'Apple Music credentials are not configured. Please set APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID, and APPLE_MUSIC_PRIVATE_KEY.'
                );
            }

            // Apple Music uses MusicKit JS for web authorization
            // For mobile apps, it uses the native MusicKit framework
            const state = `apple-music-${userId}-${Date.now()}`;

            // Generate developer token for Apple Music API
            const developerToken = this.generateDeveloperToken();

            await this.persistence.ensureIntegration('apple_music');

            // For web: redirect to MusicKit authorization
            // For mobile: return custom URL scheme
            const callbackUrl = this.getCallbackUrl();
            const authUrl = `https://authorize.music.apple.com/woa?app_name=Traeta&app_url=${encodeURIComponent(callbackUrl)}&developer_token=${developerToken}&state=${state}`;

            return {
                provider: this.name,
                redirectUrl: authUrl,
                state,
                // Additional data for mobile apps
                linkToken: developerToken
            };
        } catch (error) {
            this.logger.error(`Failed to create Apple Music connection for user ${userId}:`, error);

            // Re-throw custom exceptions
            if (error instanceof ConfigurationException) {
                throw error;
            }

            throw new ConfigurationException(
                IntegrationProviderName.APPLE_MUSIC,
                `Failed to create connection: ${error.message}`
            );
        }
    }

    async handleCallback(payload: CallbackPayload): Promise<void> {
        this.logger.log(`Apple Music callback received`);

        const { code, state, music_user_token, error } = payload;

        // Check for OAuth errors first
        if (error) {
            throw new OAuthAuthenticationException(
                IntegrationProviderName.APPLE_MUSIC,
                `Apple Music OAuth error: ${error}`
            );
        }

        if (!state) {
            throw new InvalidCallbackException(
                IntegrationProviderName.APPLE_MUSIC,
                'Missing required callback parameter: state'
            );
        }

        // Check if state has valid prefix
        if (!state.startsWith('apple-music-')) {
            throw new InvalidCallbackException(
                IntegrationProviderName.APPLE_MUSIC,
                'Invalid state prefix'
            );
        }

        // Extract userId from state format: "apple-music-<userId>-<ts>" or "apple-music-<userId>"
        // Remove "apple-music-" prefix and "-<timestamp>" suffix if present
        const stateWithoutPrefix = state.replace(/^apple-music-/, '');
        const lastDashIndex = stateWithoutPrefix.lastIndexOf('-');
        const userId = lastDashIndex > 0 ? stateWithoutPrefix.substring(0, lastDashIndex) : stateWithoutPrefix;

        // Check if userId is empty or invalid (starts with dash, which means missing userId)
        if (!userId || userId.startsWith('-')) {
            throw new InvalidCallbackException(
                IntegrationProviderName.APPLE_MUSIC,
                'Invalid state format: unable to extract userId'
            );
        }

        // Apple Music requires music_user_token, not traditional OAuth code exchange
        if (!music_user_token) {
            throw new InvalidCallbackException(
                IntegrationProviderName.APPLE_MUSIC,
                'Missing required callback parameter: music_user_token must be provided'
            );
        }

        // Store the music user token
        await this.tokens.set(userId, 'apple_music', {
            accessToken: music_user_token,
            // Music user tokens don't expire but can be revoked
            expiresAt: Math.floor(Date.now() / 1000) + 31536000, // 1 year
        });

        // Mark as connected
        const integration = await this.persistence.ensureIntegration('apple_music');
        await this.persistence.markConnected(userId, integration.integrationId);

        this.logger.log(`Apple Music connected successfully for user ${userId}`);
    }

    async sync(userId: string): Promise<{ ok: boolean; syncedAt?: Date; details?: any }> {
        const integration = await this.persistence.ensureIntegration('apple_music');
        const defaultDays = this.getDefaultDays();
        const sinceDate =
            (await this.persistence.getLastSyncedAt(userId, integration.integrationId)) ??
            new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);

        try {
            const userToken = await this.tokens.get(userId, 'apple_music');

            if (!userToken) {
                throw new InvalidTokenException(
                    IntegrationProviderName.APPLE_MUSIC
                );
            }

            // Generate developer token on-demand (it's the same for all users)
            const developerToken = this.generateDeveloperToken();

            let totalItems = 0;

            // Sync recently played tracks
            const recentlyPlayed = await this.fetchRecentlyPlayed(userToken.accessToken, developerToken, sinceDate);
            if (recentlyPlayed.length > 0) {
                await this.processRecentlyPlayed(userId, recentlyPlayed);
                totalItems += recentlyPlayed.length;
            }

            // Sync library songs
            const librarySongs = await this.fetchLibrarySongs(userToken.accessToken, developerToken, sinceDate);
            if (librarySongs.length > 0) {
                await this.processLibrarySongs(userId, librarySongs);
                totalItems += librarySongs.length;
            }

            // Sync playlists
            const playlists = await this.fetchPlaylists(userToken.accessToken, developerToken);
            if (playlists.length > 0) {
                await this.processPlaylists(userId, playlists);
                totalItems += playlists.length;
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
                    recentlyPlayed: recentlyPlayed.length,
                    librarySongs: librarySongs.length,
                    playlists: playlists.length,
                    since: sinceDate
                }
            };

        } catch (error) {
            this.logger.error(`Apple Music sync failed for user ${userId}:`, error);

            // If it's already one of our custom exceptions, re-throw it
            if (error instanceof InvalidTokenException ||
                error instanceof RateLimitException ||
                error instanceof ProviderAPIException) {
                throw error;
            }

            // Handle Axios errors from Apple Music API
            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const message = error.response?.data?.errors?.[0]?.detail || error.message;

                if (status === 429) {
                    throw new RateLimitException(
                        IntegrationProviderName.APPLE_MUSIC,
                        error.response?.headers['retry-after']
                    );
                }

                if (status === 401 || status === 403) {
                    throw new InvalidTokenException(
                        IntegrationProviderName.APPLE_MUSIC
                    );
                }

                throw new ProviderAPIException(
                    IntegrationProviderName.APPLE_MUSIC,
                    `Apple Music API error: ${message}`,
                    status ? `Status code: ${status}` : undefined
                );
            }

            // Generic sync error
            throw new DataSyncException(
                IntegrationProviderName.APPLE_MUSIC,
                `Failed to sync Apple Music data: ${error.message}`
            );
        }
    }

    async status(userId: string): Promise<{ connected: boolean; lastSyncedAt?: Date | null; details?: any }> {
        const integration = await this.persistence.ensureIntegration('apple_music');
        const link = await this.db.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
        });

        const history = link
            ? await this.db.userIntegrationHistory.findFirst({
                where: { userIntegrationId: link.userIntegrationId, userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            })
            : null;

        // Check if tokens are still valid
        const userToken = await this.tokens.get(userId, 'apple_music');

        // Check if developer token can be generated (credentials are configured)
        const teamId = this.getTeamId();
        const keyId = this.getKeyId();
        const privateKey = this.getPrivateKey();
        const hasDeveloperToken = !!(teamId && keyId && privateKey);

        return {
            connected: !!link && link.status === STATUS.CONNECTED,
            lastSyncedAt: history?.lastSyncedAt ?? null,
            details: {
                integrationId: integration.integrationId,
                popularity: integration.popularity,
                hasUserToken: !!userToken,
                hasDeveloperToken: hasDeveloperToken,
                userTokenExpiry: userToken?.expiresAt ? new Date(userToken.expiresAt * 1000) : null,
            }
        };
    }

    private generateDeveloperToken(): string {
        const teamId = this.getTeamId();
        const keyId = this.getKeyId();
        const privateKey = this.getPrivateKey();

        const now = Math.floor(Date.now() / 1000);
        const payload = {
            iss: teamId,
            iat: now,
            exp: now + 15777000, // 6 months
            aud: 'appstoreconnect-v1',
        };

        const header = {
            alg: 'ES256',
            kid: keyId,
        };

        return jwt.sign(payload, privateKey, {
            algorithm: 'ES256',
            header
        });
    }

    private async fetchRecentlyPlayed(userToken: string, devToken: string, since: Date): Promise<AppleMusicPlayHistory[]> {
        // Use mock data if enabled (for development without Apple Music subscription)
        const useMockData = this.getUseMockData();
        if (useMockData) {
            this.logger.log('🎭 Using mock data for recently played tracks (APPLE_MUSIC_USE_MOCK_DATA=true)');
            return this.getMockRecentlyPlayed(since);
        }

        try {
            const response = await axios.get('https://api.music.apple.com/v1/me/recent/played/tracks', {
                headers: {
                    'Authorization': `Bearer ${devToken}`,
                    'Music-User-Token': userToken,
                },
                params: {
                    limit: 100,
                }
            });

            const items = response.data.data || [];

            // Filter by date
            return items.filter((item: AppleMusicPlayHistory) => {
                const playedDate = new Date(item.attributes.playedDate);
                return playedDate >= since;
            });

        } catch (error) {
            // Check if it's an authentication error
            if (error.response?.status === 403 || error.response?.status === 401) {
                const errorDetail = error.response?.data?.errors?.[0];
                const errorMessage = errorDetail
                    ? `${errorDetail.title}: ${errorDetail.detail}`
                    : 'Invalid authentication';
                this.logger.error(`Authentication failed for recently played tracks: ${errorMessage}`);
                throw new Error(`Apple Music authentication failed: ${errorMessage}`);
            }

            // For other errors, log and return empty array
            this.logger.error('Failed to fetch recently played tracks:', error.message);
            return [];
        }
    }

    private async fetchLibrarySongs(userToken: string, devToken: string, since: Date): Promise<AppleMusicLibraryItem[]> {
        // Use mock data if enabled (for development without Apple Music subscription)
        const useMockData = this.getUseMockData();
        if (useMockData) {
            this.logger.log('🎭 Using mock data for library songs (APPLE_MUSIC_USE_MOCK_DATA=true)');
            return this.getMockLibrarySongs(since);
        }

        try {
            const response = await axios.get('https://api.music.apple.com/v1/me/library/songs', {
                headers: {
                    'Authorization': `Bearer ${devToken}`,
                    'Music-User-Token': userToken,
                },
                params: {
                    limit: 100,
                }
            });

            const items = response.data.data || [];

            // Filter by date added
            return items.filter((item: AppleMusicLibraryItem) => {
                const dateAdded = new Date(item.attributes.dateAdded);
                return dateAdded >= since;
            });

        } catch (error) {
            // Check if it's an authentication error
            if (error.response?.status === 403 || error.response?.status === 401) {
                const errorDetail = error.response?.data?.errors?.[0];
                const errorMessage = errorDetail
                    ? `${errorDetail.title}: ${errorDetail.detail}`
                    : 'Invalid authentication';
                this.logger.error(`Authentication failed for library songs: ${errorMessage}`);
                throw new Error(`Apple Music authentication failed: ${errorMessage}`);
            }

            // For other errors, log and return empty array
            this.logger.error('Failed to fetch library songs:', error.message);
            return [];
        }
    }

    private async fetchPlaylists(userToken: string, devToken: string): Promise<AppleMusicPlaylist[]> {
        // Use mock data if enabled (for development without Apple Music subscription)
        const useMockData = this.getUseMockData();
        if (useMockData) {
            this.logger.log('🎭 Using mock data for playlists (APPLE_MUSIC_USE_MOCK_DATA=true)');
            return this.getMockPlaylists();
        }

        try {
            const response = await axios.get('https://api.music.apple.com/v1/me/library/playlists', {
                headers: {
                    'Authorization': `Bearer ${devToken}`,
                    'Music-User-Token': userToken,
                },
                params: {
                    limit: 100,
                    include: 'tracks',
                }
            });

            return response.data.data || [];

        } catch (error) {
            // Check if it's an authentication error
            if (error.response?.status === 403 || error.response?.status === 401) {
                const errorDetail = error.response?.data?.errors?.[0];
                const errorMessage = errorDetail
                    ? `${errorDetail.title}: ${errorDetail.detail}`
                    : 'Invalid authentication';
                this.logger.error(`Authentication failed for playlists: ${errorMessage}`);
                throw new Error(`Apple Music authentication failed: ${errorMessage}`);
            }

            // For other errors, log and return empty array
            this.logger.error('Failed to fetch playlists:', error.message);
            return [];
        }
    }

    private async processRecentlyPlayed(userId: string, playHistory: AppleMusicPlayHistory[]): Promise<void> {
        for (const play of playHistory) {
            const track = play.attributes.track;
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Music', 'Recently Played');

            const playedDate = new Date(play.attributes.playedDate);
            const durationMs = play.attributes.playDurationMillis || track.attributes.durationInMillis;

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `${track.attributes.name} | Recently Played`,
                {
                    playedAt: playedDate.toISOString(),
                    trackName: track.attributes.name,
                    artistName: track.attributes.artistName,
                    albumName: track.attributes.albumName,
                    durationMs: durationMs,
                    playDurationMs: play.attributes.playDurationMillis,
                    endReason: play.attributes.endReasonType,
                    genres: track.attributes.genreNames || [],
                    artwork: track.attributes.artwork?.url || null,
                    isrc: track.attributes.isrc || null,
                    external: {
                        provider: 'apple_music',
                        id: play.id,
                        type: 'play_history',
                        trackId: track.id
                    },
                },
                {
                    playedAt: DATA_TYPE.STRING,
                    trackName: DATA_TYPE.STRING,
                    artistName: DATA_TYPE.STRING,
                    albumName: DATA_TYPE.STRING,
                    durationMs: DATA_TYPE.NUMBER,
                    playDurationMs: DATA_TYPE.NUMBER,
                    endReason: DATA_TYPE.STRING,
                    genres: [],
                    artwork: DATA_TYPE.STRING,
                    isrc: DATA_TYPE.STRING,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING,
                        trackId: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private async processLibrarySongs(userId: string, librarySongs: AppleMusicLibraryItem[]): Promise<void> {
        for (const song of librarySongs) {
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Music', 'Library');

            const dateAdded = new Date(song.attributes.dateAdded);

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `${song.attributes.name} | Library`,
                {
                    addedAt: dateAdded.toISOString(),
                    trackName: song.attributes.name,
                    artistName: song.attributes.artistName,
                    albumName: song.attributes.albumName || null,
                    playCount: song.attributes.playCount || 0,
                    artwork: song.attributes.artwork?.url || null,
                    external: {
                        provider: 'apple_music',
                        id: song.id,
                        type: 'library_song'
                    },
                },
                {
                    addedAt: DATA_TYPE.STRING,
                    trackName: DATA_TYPE.STRING,
                    artistName: DATA_TYPE.STRING,
                    albumName: DATA_TYPE.STRING,
                    playCount: DATA_TYPE.NUMBER,
                    artwork: DATA_TYPE.STRING,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING,
                        trackId: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private async processPlaylists(userId: string, playlists: AppleMusicPlaylist[]): Promise<void> {
        for (const playlist of playlists) {
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Music', 'Playlists');

            const dateAdded = new Date(playlist.attributes.dateAdded);
            const lastModified = new Date(playlist.attributes.lastModifiedDate);

            const tracks = playlist.relationships?.tracks?.data || [];

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `${playlist.attributes.name} | Playlists`,
                {
                    createdAt: dateAdded.toISOString(),
                    lastModifiedAt: lastModified.toISOString(),
                    playlistName: playlist.attributes.name,
                    description: playlist.attributes.description?.standard || null,
                    isPublic: playlist.attributes.isPublic,
                    canEdit: playlist.attributes.canEdit,
                    trackCount: tracks.length,
                    tracks: tracks.map(track => ({
                        id: track.id,
                        name: track.attributes.name,
                        artistName: track.attributes.artistName,
                        albumName: track.attributes.albumName,
                        durationMs: track.attributes.durationInMillis,
                    })),
                    artwork: playlist.attributes.artwork?.url || null,
                    external: {
                        provider: 'apple_music',
                        id: playlist.id,
                        type: 'playlist'
                    },
                },
                {
                    createdAt: DATA_TYPE.STRING,
                    lastModifiedAt: DATA_TYPE.STRING,
                    playlistName: DATA_TYPE.STRING,
                    description: DATA_TYPE.STRING,
                    isPublic: DATA_TYPE.BOOLEAN,
                    canEdit: DATA_TYPE.BOOLEAN,
                    trackCount: DATA_TYPE.NUMBER,
                    tracks: [],
                    artwork: DATA_TYPE.STRING,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING,
                        trackId: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    // ==================== MOCK DATA METHODS (FOR DEVELOPMENT) ====================
    // These methods provide realistic test data when APPLE_MUSIC_USE_MOCK_DATA=true
    // This allows development and testing without an Apple Music subscription

    private getMockRecentlyPlayed(since: Date): AppleMusicPlayHistory[] {
        const now = new Date();
        const mockData: AppleMusicPlayHistory[] = [
            {
                id: 'mock-play-1',
                type: 'play-history',
                attributes: {
                    playedDate: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
                    playDurationMillis: 200000,
                    endReasonType: 'NATURAL_END_OF_TRACK',
                    track: {
                        id: 'mock-track-1',
                        type: 'songs',
                        attributes: {
                            name: 'Blinding Lights',
                            artistName: 'The Weeknd',
                            albumName: 'After Hours',
                            durationInMillis: 200040,
                            genreNames: ['Pop', 'R&B/Soul'],
                            releaseDate: '2020-03-20',
                            isrc: 'USUG11903920',
                            artwork: {
                                url: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/6b/95/2d/6b952d18-1e5a-5f3e-6a94-6a4f7e6e6e6e/cover.jpg/{w}x{h}bb.jpg',
                                width: 3000,
                                height: 3000,
                            },
                            playParams: {
                                id: 'mock-track-1',
                                kind: 'song',
                            },
                        },
                    },
                },
            },
            {
                id: 'mock-play-2',
                type: 'play-history',
                attributes: {
                    playedDate: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(), // 5 hours ago
                    playDurationMillis: 203000,
                    endReasonType: 'NATURAL_END_OF_TRACK',
                    track: {
                        id: 'mock-track-2',
                        type: 'songs',
                        attributes: {
                            name: 'Levitating',
                            artistName: 'Dua Lipa',
                            albumName: 'Future Nostalgia',
                            durationInMillis: 203064,
                            genreNames: ['Pop', 'Dance'],
                            releaseDate: '2020-03-27',
                            isrc: 'GBAHT2000171',
                            artwork: {
                                url: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/7a/8b/3c/7a8b3c1d-2e4f-5a6b-7c8d-9e0f1a2b3c4d/cover.jpg/{w}x{h}bb.jpg',
                                width: 3000,
                                height: 3000,
                            },
                            playParams: {
                                id: 'mock-track-2',
                                kind: 'song',
                            },
                        },
                    },
                },
            },
            {
                id: 'mock-play-3',
                type: 'play-history',
                attributes: {
                    playedDate: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), // 1 day ago
                    playDurationMillis: 178000,
                    endReasonType: 'SKIPPED_FORWARDS',
                    track: {
                        id: 'mock-track-3',
                        type: 'songs',
                        attributes: {
                            name: 'good 4 u',
                            artistName: 'Olivia Rodrigo',
                            albumName: 'SOUR',
                            durationInMillis: 178147,
                            genreNames: ['Pop', 'Alternative'],
                            releaseDate: '2021-05-14',
                            isrc: 'USUG12101799',
                            artwork: {
                                url: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/9a/1b/2c/9a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d/cover.jpg/{w}x{h}bb.jpg',
                                width: 3000,
                                height: 3000,
                            },
                            playParams: {
                                id: 'mock-track-3',
                                kind: 'song',
                            },
                        },
                    },
                },
            },
        ];

        // Filter by date
        return mockData.filter(item => {
            const playedDate = new Date(item.attributes.playedDate);
            return playedDate >= since;
        });
    }

    private getMockLibrarySongs(since: Date): AppleMusicLibraryItem[] {
        const now = new Date();
        const mockData: AppleMusicLibraryItem[] = [
            {
                id: 'mock-library-1',
                type: 'library-songs',
                attributes: {
                    name: 'Shape of You',
                    artistName: 'Ed Sheeran',
                    albumName: '÷ (Deluxe)',
                    dateAdded: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
                    playCount: 42,
                    artwork: {
                        url: 'https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/1a/2b/3c/1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d/cover.jpg/{w}x{h}bb.jpg',
                        width: 3000,
                        height: 3000,
                    },
                },
            },
            {
                id: 'mock-library-2',
                type: 'library-songs',
                attributes: {
                    name: 'Watermelon Sugar',
                    artistName: 'Harry Styles',
                    albumName: 'Fine Line',
                    dateAdded: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days ago
                    playCount: 28,
                    artwork: {
                        url: 'https://is1-ssl.mzstatic.com/image/thumb/Music113/v4/2a/3b/4c/2a3b4c5d-6e7f-8a9b-0c1d-2e3f4a5b6c7d/cover.jpg/{w}x{h}bb.jpg',
                        width: 3000,
                        height: 3000,
                    },
                },
            },
        ];

        // Filter by date added
        return mockData.filter(item => {
            const dateAdded = new Date(item.attributes.dateAdded);
            return dateAdded >= since;
        });
    }

    private getMockPlaylists(): AppleMusicPlaylist[] {
        const now = new Date();
        return [
            {
                id: 'mock-playlist-1',
                type: 'library-playlists',
                attributes: {
                    name: 'My Favorites',
                    description: {
                        standard: 'A collection of my favorite songs',
                    },
                    dateAdded: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days ago
                    lastModifiedDate: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
                    isPublic: false,
                    canEdit: true,
                    artwork: {
                        url: 'https://is1-ssl.mzstatic.com/image/thumb/Features125/v4/3a/4b/5c/3a4b5c6d-7e8f-9a0b-1c2d-3e4f5a6b7c8d/cover.jpg/{w}x{h}bb.jpg',
                        width: 1000,
                        height: 1000,
                    },
                },
                relationships: {
                    tracks: {
                        data: [
                            {
                                id: 'mock-track-1',
                                type: 'songs',
                                attributes: {
                                    name: 'Blinding Lights',
                                    artistName: 'The Weeknd',
                                    albumName: 'After Hours',
                                    durationInMillis: 200040,
                                    genreNames: ['Pop'],
                                    artwork: {
                                        url: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/6b/95/2d/cover.jpg/{w}x{h}bb.jpg',
                                        width: 3000,
                                        height: 3000,
                                    },
                                },
                            },
                            {
                                id: 'mock-track-2',
                                type: 'songs',
                                attributes: {
                                    name: 'Levitating',
                                    artistName: 'Dua Lipa',
                                    albumName: 'Future Nostalgia',
                                    durationInMillis: 203064,
                                    genreNames: ['Pop'],
                                    artwork: {
                                        url: 'https://is1-ssl.mzstatic.com/image/thumb/Music115/v4/7a/8b/3c/cover.jpg/{w}x{h}bb.jpg',
                                        width: 3000,
                                        height: 3000,
                                    },
                                },
                            },
                        ],
                    },
                },
            },
            {
                id: 'mock-playlist-2',
                type: 'library-playlists',
                attributes: {
                    name: 'Workout Mix',
                    description: {
                        standard: 'High energy tracks for workouts',
                    },
                    dateAdded: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
                    lastModifiedDate: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
                    isPublic: true,
                    canEdit: true,
                    artwork: {
                        url: 'https://is1-ssl.mzstatic.com/image/thumb/Features115/v4/4a/5b/6c/4a5b6c7d-8e9f-0a1b-2c3d-4e5f6a7b8c9d/cover.jpg/{w}x{h}bb.jpg',
                        width: 1000,
                        height: 1000,
                    },
                },
                relationships: {
                    tracks: {
                        data: [
                            {
                                id: 'mock-track-3',
                                type: 'songs',
                                attributes: {
                                    name: 'good 4 u',
                                    artistName: 'Olivia Rodrigo',
                                    albumName: 'SOUR',
                                    durationInMillis: 178147,
                                    genreNames: ['Pop'],
                                    artwork: {
                                        url: 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/9a/1b/2c/cover.jpg/{w}x{h}bb.jpg',
                                        width: 3000,
                                        height: 3000,
                                    },
                                },
                            },
                        ],
                    },
                },
            },
        ];
    }
}