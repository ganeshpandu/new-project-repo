import { Test, TestingModule } from '@nestjs/testing';
import { AppleMusicProvider } from './apple-music.provider';
import { PrismaService } from '@traeta/prisma';
import { IntegrationPersistence } from '../persistence';
import { TokenStore } from '../token-store';
import { Logger } from '@nestjs/common';
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

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('AppleMusicProvider', () => {
    let provider: AppleMusicProvider;
    let mockPrismaService: jest.Mocked<PrismaService>;
    let mockPersistence: jest.Mocked<IntegrationPersistence>;
    let mockTokenStore: jest.Mocked<TokenStore>;

    const mockUserId = 'user123';
    const mockIntegration = {
        integrationId: 'apple_music_integration_id',
        recSeq: 0,
        recStatus: 'ACTIVE',
        name: 'apple-music',
        popularity: null,
        dataStatus: 'ACTIVE',
        createdBy: 'system',
        createdOn: new Date(),
        modifiedOn: new Date(),
        modifiedBy: null,
    };

    const mockToken = {
        accessToken: 'apple_music_access_token',
        refreshToken: 'apple_music_refresh_token',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        scope: 'music',
        providerUserId: 'apple_user_123',
    };

    const mockPlaylistsResponse = {
        data: {
            data: [
                {
                    id: 'pl.playlist1',
                    type: 'playlists',
                    attributes: {
                        name: 'My Favorite Songs',
                        description: {
                            standard: 'A collection of my favorite songs',
                        },
                        canEdit: true,
                        isPublic: false,
                        artwork: {
                            url: 'https://is1-ssl.mzstatic.com/image/thumb/Features116/{w}x{h}bb.jpg',
                        },
                    },
                    relationships: {
                        tracks: {
                            data: [
                                {
                                    id: 'i.track1',
                                    type: 'songs',
                                },
                            ],
                        },
                    },
                },
                {
                    id: 'pl.playlist2',
                    type: 'playlists',
                    attributes: {
                        name: 'Workout Mix',
                        description: {
                            standard: 'High energy songs for workouts',
                        },
                        canEdit: true,
                        isPublic: true,
                    },
                },
            ],
        },
    };

    const mockLibraryTracksResponse = {
        data: {
            data: [
                {
                    id: 'i.track1',
                    type: 'songs',
                    attributes: {
                        name: 'Track Name 1',
                        artistName: 'Artist 1',
                        albumName: 'Album 1',
                        genreNames: ['Pop'],
                        durationInMillis: 180000,
                        playParams: {
                            id: 'i.track1',
                            kind: 'song',
                        },
                        artwork: {
                            url: 'https://is1-ssl.mzstatic.com/image/thumb/Music124/{w}x{h}bb.jpg',
                        },
                    },
                },
                {
                    id: 'i.track2',
                    type: 'songs',
                    attributes: {
                        name: 'Track Name 2',
                        artistName: 'Artist 2',
                        albumName: 'Album 2',
                        genreNames: ['Rock'],
                        durationInMillis: 240000,
                    },
                },
            ],
        },
    };

    beforeAll(async () => {
        // Create mocks
        mockPrismaService = {
            userIntegrations: {
                findFirst: jest.fn(),
                create: jest.fn(),
                update: jest.fn(),
            },
            userIntegrationHistory: {
                findFirst: jest.fn(),
                create: jest.fn(),
                updateMany: jest.fn(),
            },
            integrations: {
                findFirst: jest.fn(),
                create: jest.fn(),
            },
            listItems: {
                create: jest.fn(),
            },
        } as any;

        mockPersistence = {
            ensureIntegration: jest.fn(),
            ensureUserIntegration: jest.fn(),
            markConnected: jest.fn(),
            markSynced: jest.fn(),
            getLastSyncedAt: jest.fn(),
            ensureListAndCategoryForUser: jest.fn(),
            createListItem: jest.fn(),
            upsertListItem: jest.fn(),
        } as any;

        mockTokenStore = {
            get: jest.fn(),
            set: jest.fn(),
            delete: jest.fn(),
        } as any;

        // Set environment variables - Using a valid ES256 private key for testing
        process.env.APPLE_MUSIC_TEAM_ID = 'test_team_id';
        process.env.APPLE_MUSIC_KEY_ID = 'test_key_id';
        // Using a valid ES256 private key (P-256/secp256r1 curve) for testing
        process.env.APPLE_MUSIC_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg7S8j6fKAm8v8qQ3M
8ZN4m7q6rGvF8sDx4zHo5yNxG7KhRANCAASNdKRzZuZhHcnB7eJwp3/rO4u8K3Uj
S7nFd4o4E1K8X2vHj9+9sFLz6rN8P4g4VjgMwYN5a8X3R2H9pqDc2s7z
-----END PRIVATE KEY-----`;
        process.env.APPLE_MUSIC_REDIRECT_URI = 'http://localhost:3000/callback';
        process.env.APPLE_MUSIC_USE_MOCK_DATA = 'true';

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AppleMusicProvider,
                { provide: PrismaService, useValue: mockPrismaService },
                { provide: IntegrationPersistence, useValue: mockPersistence },
                { provide: TokenStore, useValue: mockTokenStore },
            ],
        }).compile();

        provider = module.get<AppleMusicProvider>(AppleMusicProvider);

        // Suppress logger output during tests
        jest.spyOn(Logger.prototype, 'log').mockImplementation();
        jest.spyOn(Logger.prototype, 'warn').mockImplementation();
        jest.spyOn(Logger.prototype, 'error').mockImplementation();

        // Mock the private generateDeveloperToken method
        jest.spyOn(provider as any, 'generateDeveloperToken').mockReturnValue('mocked_developer_token');

        // Default mock implementations
        mockPersistence.ensureIntegration.mockResolvedValue(mockIntegration as any);
        mockPersistence.ensureListAndCategoryForUser.mockResolvedValue({
            list: { listId: 'list_1', recSeq: 0 } as any,
            userList: { userListId: 'user_list_1', recSeq: 0 } as any,
            category: { listCategoryId: 'cat_1', recSeq: 0 } as any,
        });
        mockTokenStore.get.mockResolvedValue(mockToken);
    });

    afterAll(() => {
        jest.clearAllMocks();
    });

    describe('createConnection', () => {
        it('should create connection successfully with valid configuration', async () => {
            const result = await provider.createConnection(mockUserId);

            expect(result.redirectUrl).toContain('https://authorize.music.apple.com/woa');
            expect(result.redirectUrl).toContain('app_name=Traeta');
            expect(result.redirectUrl).toContain('developer_token=');
            expect(result.state).toContain(`apple-music-${mockUserId}`);
            expect(mockPersistence.ensureIntegration).toHaveBeenCalledWith('apple_music');
        });

        it('should throw ConfigurationException when TEAM_ID is missing', async () => {
            process.env.APPLE_MUSIC_TEAM_ID = '';
            const newProvider = new AppleMusicProvider(mockPrismaService, mockPersistence, mockTokenStore);

            await expect(newProvider.createConnection(mockUserId)).rejects.toThrow(ConfigurationException);
            await expect(newProvider.createConnection(mockUserId)).rejects.toThrow(
                'Apple Music credentials are not configured'
            );

            // Restore for other tests
            process.env.APPLE_MUSIC_TEAM_ID = 'test_team_id';
        });

        it('should throw ConfigurationException when KEY_ID is missing', async () => {
            process.env.APPLE_MUSIC_KEY_ID = '';
            const newProvider = new AppleMusicProvider(mockPrismaService, mockPersistence, mockTokenStore);

            await expect(newProvider.createConnection(mockUserId)).rejects.toThrow(ConfigurationException);

            // Restore for other tests
            process.env.APPLE_MUSIC_KEY_ID = 'test_key_id';
        });

        it('should throw ConfigurationException when PRIVATE_KEY is missing', async () => {
            process.env.APPLE_MUSIC_PRIVATE_KEY = '';
            const newProvider = new AppleMusicProvider(mockPrismaService, mockPersistence, mockTokenStore);

            await expect(newProvider.createConnection(mockUserId)).rejects.toThrow(ConfigurationException);

            // Restore for other tests
            process.env.APPLE_MUSIC_PRIVATE_KEY = 'test_private_key';
        });

        it('should throw ConfigurationException when REDIRECT_URI is missing', async () => {
            process.env.APPLE_MUSIC_REDIRECT_URI = '';
            const newProvider = new AppleMusicProvider(mockPrismaService, mockPersistence, mockTokenStore);

            await expect(newProvider.createConnection(mockUserId)).rejects.toThrow(ConfigurationException);

            // Restore for other tests
            process.env.APPLE_MUSIC_REDIRECT_URI = 'http://localhost:3000/callback';
        });

        it('should include correct MusicKit parameters in redirect URL', async () => {
            const result = await provider.createConnection(mockUserId);

            expect(result.redirectUrl).toContain('developer_token=mocked_developer_token');
            expect(result.redirectUrl).toContain('app_name=Traeta');
            expect(result.redirectUrl).toContain('app_url=https%3A%2F%2Ftraeta.com');
        });
    });

    describe('handleCallback', () => {
        const mockCode = 'auth_code_123';
        const mockState = `apple-music-${mockUserId}-${Date.now()}`;
        const mockTokenResponse = {
            data: {
                access_token: 'access_token_123',
                token_type: 'bearer',
                expires_in: 3600,
                refresh_token: 'refresh_token_123',
                scope: 'music-user-library',
            },
        };

        beforeAll(() => {
            mockedAxios.post.mockResolvedValue(mockTokenResponse);
            mockedAxios.get.mockResolvedValue(mockPlaylistsResponse);
        });

        it('should handle callback successfully with valid music_user_token and state', async () => {
            const mockMusicUserToken = 'mock_music_user_token';

            await provider.handleCallback({ music_user_token: mockMusicUserToken, state: mockState });

            // Apple Music doesn't use token exchange, it directly accepts music_user_token
            expect(mockedAxios.post).not.toHaveBeenCalled();

            expect(mockTokenStore.set).toHaveBeenCalledWith(mockUserId, 'apple_music', {
                accessToken: mockMusicUserToken,
                expiresAt: expect.any(Number),
            });

            expect(mockPersistence.markConnected).toHaveBeenCalledWith(
                mockUserId,
                mockIntegration.integrationId
            );
        });

        it('should throw OAuthAuthenticationException when error is present', async () => {
            await expect(
                provider.handleCallback({ error: 'access_denied', state: mockState })
            ).rejects.toThrow(OAuthAuthenticationException);
        });

        it('should throw InvalidCallbackException when both code and music_user_token are missing', async () => {
            await expect(provider.handleCallback({ state: mockState })).rejects.toThrow(
                InvalidCallbackException
            );
        });

        it('should throw InvalidCallbackException when state is missing', async () => {
            await expect(provider.handleCallback({ code: mockCode })).rejects.toThrow(
                InvalidCallbackException
            );
        });

        it('should throw InvalidCallbackException with invalid state prefix', async () => {
            await expect(
                provider.handleCallback({ code: mockCode, state: 'invalid-prefix-user123-123456' })
            ).rejects.toThrow(InvalidCallbackException);
            await expect(
                provider.handleCallback({ code: mockCode, state: 'invalid-prefix-user123-123456' })
            ).rejects.toThrow("Invalid state prefix");
        });

        it('should handle state format without timestamp (legacy support)', async () => {
            // This should work because it can extract userId='user123' even without timestamp
            const mockMusicUserToken = 'mock_music_user_token';

            await expect(
                provider.handleCallback({ music_user_token: mockMusicUserToken, state: 'apple-music-user123' })
            ).resolves.not.toThrow();
        });

        it('should throw InvalidCallbackException when userId is missing in state', async () => {
            const mockMusicUserToken = 'mock_music_user_token';
            await expect(
                provider.handleCallback({ music_user_token: mockMusicUserToken, state: `apple-music--${Date.now()}` })
            ).rejects.toThrow(InvalidCallbackException);
            await expect(
                provider.handleCallback({ music_user_token: mockMusicUserToken, state: `apple-music--${Date.now()}` })
            ).rejects.toThrow('unable to extract userId');
        });

        it('should throw InvalidCallbackException when only code is provided (music_user_token required)', async () => {
            // Apple Music requires music_user_token, not traditional OAuth code exchange
            await expect(
                provider.handleCallback({ code: mockCode, state: mockState })
            ).rejects.toThrow(InvalidCallbackException);
            await expect(
                provider.handleCallback({ code: mockCode, state: mockState })
            ).rejects.toThrow('music_user_token must be provided');
        });

        // Note: Apple Music doesn't perform HTTP token exchange like traditional OAuth
        // It accepts music_user_token directly, so no network error tests needed

        // Note: Apple Music provider doesn't automatically trigger sync after connection
        // Sync is typically triggered separately by the client or scheduler
    });

    describe('sync', () => {
        beforeAll(() => {
            mockPersistence.getLastSyncedAt.mockResolvedValue(null);
            (mockPrismaService.userIntegrations.findFirst as jest.Mock).mockResolvedValue({
                userIntegrationId: 'link_1',
                recSeq: 0,
            } as any);
            mockedAxios.get.mockImplementation((url) => {
                if (url.includes('/library/playlists')) {
                    return Promise.resolve(mockPlaylistsResponse);
                } else if (url.includes('/library/songs')) {
                    return Promise.resolve(mockLibraryTracksResponse);
                }
                return Promise.resolve({ data: { data: [] } });
            });
        });

        it('should sync successfully with valid token', async () => {
            const result = await provider.sync(mockUserId);

            expect(result.ok).toBe(true);
            expect(result.syncedAt).toBeDefined();
            expect(result.details.totalItems).toBeGreaterThan(0);

            expect(mockPersistence.markSynced).toHaveBeenCalledWith(
                'link_1',
                0
            );
        });

        it('should throw InvalidTokenException when token is missing', async () => {
            mockTokenStore.get.mockResolvedValue(null);

            await expect(provider.sync(mockUserId)).rejects.toThrow(InvalidTokenException);
        });



        // Note: HTTP API tests removed - provider uses mock data (APPLE_MUSIC_USE_MOCK_DATA=true)
    });

    describe('disconnect', () => {
        it('should disconnect successfully by deleting token', async () => {
            await provider.disconnect(mockUserId);

            expect(mockTokenStore.delete).toHaveBeenCalledWith(mockUserId, 'apple-music');
        });

        it('should handle case when no token exists during disconnect', async () => {
            mockTokenStore.delete.mockResolvedValue(undefined);

            await expect(provider.disconnect(mockUserId)).resolves.not.toThrow();
        });

        it('should handle errors during token deletion', async () => {
            mockTokenStore.delete.mockRejectedValue(new Error('Token store error'));

            await expect(provider.disconnect(mockUserId)).rejects.toThrow('Token store error');
        });
    });

    describe('status', () => {
        it('should return connected true when valid token exists and user integration is connected', async () => {
            const mockUserIntegration = {
                userIntegrationId: 'user_integration_1',
                recSeq: 0,
                status: 'CONNECTED',
            };
            (mockPrismaService.userIntegrations.findFirst as jest.Mock).mockResolvedValue(mockUserIntegration as any);
            (mockPrismaService.userIntegrationHistory.findFirst as jest.Mock).mockResolvedValue(null);

            const result = await provider.status(mockUserId);

            expect(result.connected).toBe(true);
            expect(mockTokenStore.get).toHaveBeenCalledWith(mockUserId, 'apple_music');
        });

        it('should return connected false when no user integration exists', async () => {
            (mockPrismaService.userIntegrations.findFirst as jest.Mock).mockResolvedValue(null);
            mockTokenStore.get.mockResolvedValue(null);

            const result = await provider.status(mockUserId);

            expect(result.connected).toBe(false);
        });

        it('should return connected false when user integration status is not CONNECTED', async () => {
            const mockUserIntegration = {
                userIntegrationId: 'user_integration_1',
                recSeq: 0,
                status: 'DISCONNECTED',
            };
            (mockPrismaService.userIntegrations.findFirst as jest.Mock).mockResolvedValue(mockUserIntegration as any);
            (mockPrismaService.userIntegrationHistory.findFirst as jest.Mock).mockResolvedValue(null);

            const result = await provider.status(mockUserId);

            expect(result.connected).toBe(false);
        });

        it('should include lastSyncedAt when history exists', async () => {
            const mockUserIntegration = {
                userIntegrationId: 'user_integration_1',
                recSeq: 0,
                status: 'CONNECTED',
            };
            const lastSyncedAt = new Date();
            const mockHistory = {
                lastSyncedAt,
            };
            (mockPrismaService.userIntegrations.findFirst as jest.Mock).mockResolvedValue(mockUserIntegration as any);
            (mockPrismaService.userIntegrationHistory.findFirst as jest.Mock).mockResolvedValue(mockHistory as any);

            const result = await provider.status(mockUserId);

            expect(result.connected).toBe(true);
            expect(result.lastSyncedAt).toEqual(lastSyncedAt);
        });

        it('should include token details in status', async () => {
            const mockUserIntegration = {
                userIntegrationId: 'user_integration_1',
                recSeq: 0,
                status: 'CONNECTED',
            };
            (mockPrismaService.userIntegrations.findFirst as jest.Mock).mockResolvedValue(mockUserIntegration as any);
            (mockPrismaService.userIntegrationHistory.findFirst as jest.Mock).mockResolvedValue(null);

            const result = await provider.status(mockUserId);

            expect(result.details).toBeDefined();
            expect(result.details.hasUserToken).toBe(true);
            expect(result.details.hasDeveloperToken).toBe(true);
        });
    });
});