import { Body, Controller, Get, Param, Post, Query, HttpStatus, UseGuards, SetMetadata } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { IntegrationsService } from './integrations.service';
import { IntegrationProviderName } from './types';
// import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';
import { JwtAuthGuard } from 'src/guards/guards';
import { UserOwnershipGuard } from './guards/user-ownership.guard';
import { CurrentUser, AuthenticatedUser } from './decorators/current-user.decorator';
import { IntegrationErrorResponseDto } from './dto/error-response.dto';

// Decorator to mark endpoints as public (skip authentication)
export const Public = () => SetMetadata('isPublic', true);

@ApiTags('Integrations')
@Controller('integrations')
@UseGuards(JwtAuthGuard) // Apply authentication to all endpoints by default
@ApiBearerAuth()
export class IntegrationsController {
    constructor(private readonly integrations: IntegrationsService) { }

    // 1) Start connection flow for a provider
    @Post(':provider/connect')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Connect to an integration provider',
        description: 'Initiates the OAuth connection flow for a specific integration provider (Spotify, Strava, Plaid, Apple Music, etc.)'
    })
    @ApiParam({
        name: 'provider',
        description: 'Integration provider name',
        enum: ['spotify', 'strava', 'plaid', 'apple_music', 'apple_health', 'goodreads', 'email_scraper', 'contact_list', 'location_services'],
        example: 'spotify'
    })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'User ID (must match authenticated user)', example: 'user-123-abc' }
            },
            required: ['userId']
        }
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Connection initiated successfully. Returns provider name, authorization URL or upload token, and state.',
        schema: {
            type: 'object',
            properties: {
                provider: { type: 'string', example: 'spotify' },
                redirectUrl: { type: 'string', example: 'https://accounts.spotify.com/authorize?...' },
                linkToken: { type: 'string', example: 'link-token-abc-123' },
                state: { type: 'string', example: 'spotify-user123-1234567890' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid provider or userId',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found - Unsupported integration provider',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Configuration error or internal server error',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.BAD_GATEWAY,
        description: 'Provider API error - External service unavailable',
        type: IntegrationErrorResponseDto
    })
    async connect(
        @Param('provider') providerParam: string,
        @Body('userId') userId: string,
        @CurrentUser() user: AuthenticatedUser,
    ) {
        const provider = providerParam as IntegrationProviderName;
        return this.integrations.createConnection(provider, userId);
    }

    // 2) Callback endpoint
    @Public() // OAuth callbacks are called by external providers, not authenticated users
    @Post(':provider/callback')
    @ApiOperation({
        summary: 'OAuth callback endpoint',
        description: 'Handles OAuth callback from integration providers. Automatically returns user data for Spotify, Strava, Plaid, Apple Music, and Email Scraper. This endpoint is public as it\'s called by external OAuth providers.'
    })
    @ApiParam({
        name: 'provider',
        description: 'Integration provider name',
        example: 'spotify'
    })
    @ApiBody({
        description: 'OAuth callback payload from provider',
        schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Authorization code' },
                state: { type: 'string', description: 'State parameter' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Callback processed successfully',
        schema: {
            type: 'object',
            properties: {
                ok: { type: 'boolean', example: true },
                user: { type: 'object', description: 'User data' },
                syncedData: { type: 'object', description: 'Synced integration data' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid callback payload - Missing required parameters or error in OAuth flow',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'OAuth authentication failed - Invalid authorization code or token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found or user data not found',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.PRECONDITION_FAILED,
        description: 'User not connected to provider',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Data sync failed or internal server error',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.BAD_GATEWAY,
        description: 'Provider API error - Failed to exchange token or fetch data',
        type: IntegrationErrorResponseDto
    })
    async callbackPost(
        @Param('provider') providerParam: string,
        @Body() payload: any,
    ) {
        const provider = providerParam as IntegrationProviderName;

        // For Spotify, Strava, Plaid, Apple Music, and Email Scraper, always return user data with synced content
        if (provider === IntegrationProviderName.SPOTIFY || provider === IntegrationProviderName.STRAVA || provider === IntegrationProviderName.PLAID || provider === IntegrationProviderName.APPLE_MUSIC || provider === IntegrationProviderName.EMAIL_SCRAPER) {
            return this.integrations.handleCallbackWithUserData(provider, payload);
        }

        await this.integrations.handleCallback(provider, payload);
        return { ok: true };
    }

    // // 2a) Endpoint specifically for callbacks that return user data
    // @Public() // OAuth callbacks are called by external providers, not authenticated users
    // @Post(':provider/callback-with-data')
    // @ApiOperation({
    //     summary: 'OAuth callback with user data',
    //     description: 'Handles OAuth callback and always returns user data with synced content. This endpoint is public as it\'s called by external OAuth providers.'
    // })
    // @ApiParam({
    //     name: 'provider',
    //     description: 'Integration provider name',
    //     example: 'spotify'
    // })
    // @ApiBody({
    //     description: 'OAuth callback payload',
    //     schema: { type: 'object' }
    // })
    // @ApiResponse({
    //     status: HttpStatus.OK,
    //     description: 'Returns user data with synced integration content'
    // })
    // @ApiResponse({
    //     status: HttpStatus.BAD_REQUEST,
    //     description: 'Invalid callback payload',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.UNAUTHORIZED,
    //     description: 'OAuth authentication failed',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.NOT_FOUND,
    //     description: 'Provider or user data not found',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.INTERNAL_SERVER_ERROR,
    //     description: 'Data sync failed',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.BAD_GATEWAY,
    //     description: 'Provider API error',
    //     type: IntegrationErrorResponseDto
    // })
    // async callbackWithDataPost(
    //     @Param('provider') providerParam: string,
    //     @Body() payload: any,
    // ) {
    //     const provider = providerParam as IntegrationProviderName;
    //     return this.integrations.handleCallbackWithUserData(provider, payload);
    // }

    // 3) Trigger sync manually
    @Post(':provider/sync')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Manually trigger data sync',
        description: 'Triggers a manual sync of data from the integration provider for a specific user'
    })
    @ApiParam({
        name: 'provider',
        description: 'Integration provider name',
        example: 'spotify'
    })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'User ID (must match authenticated user)', example: 'user-123-abc' }
            },
            required: ['userId']
        }
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Sync completed successfully',
        schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: true },
                syncedData: { type: 'object', description: 'Synced data from provider' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid request parameters',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.PRECONDITION_FAILED,
        description: 'User not connected to provider',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.TOO_MANY_REQUESTS,
        description: 'Rate limit exceeded',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Data sync failed or internal server error',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.BAD_GATEWAY,
        description: 'Provider API error - External service unavailable',
        type: IntegrationErrorResponseDto
    })
    async sync(
        @Param('provider') providerParam: string,
        @Body('userId') userId: string,
        @CurrentUser() user: AuthenticatedUser,
    ) {
        const provider = providerParam as IntegrationProviderName;
        return this.integrations.sync(provider, userId);
    }

    // 4) Connection status
    @Get(':provider/status')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Get integration connection status',
        description: 'Retrieves the current connection status for a user\'s integration'
    })
    @ApiParam({
        name: 'provider',
        description: 'Integration provider name',
        example: 'spotify'
    })
    @ApiQuery({
        name: 'userId',
        required: true,
        description: 'User ID (must match authenticated user)',
        example: 'user-123-abc'
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Connection status retrieved successfully',
        schema: {
            type: 'object',
            properties: {
                connected: { type: 'boolean', example: true },
                lastSyncedAt: { type: 'string', format: 'date-time', example: '2025-01-15T10:30:00Z' },
                status: { type: 'string', example: 'active' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid request parameters',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Internal server error',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.BAD_GATEWAY,
        description: 'Provider API error',
        type: IntegrationErrorResponseDto
    })
    async status(
        @Param('provider') providerParam: string,
        @Query('userId') userId: string,
        @CurrentUser() user: AuthenticatedUser,
    ) {
        const provider = providerParam as IntegrationProviderName;
        return this.integrations.status(provider, userId);
    }

    // 4a) Get all integration statuses
    @Get('status/all')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Get all integration connection statuses',
        description: 'Retrieves the connection status for all integration providers for a specific user'
    })
    @ApiQuery({
        name: 'userId',
        required: true,
        description: 'User ID (must match authenticated user)',
        example: 'user-123-abc'
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'All integration statuses retrieved successfully',
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', example: 'user-123-abc' },
                integrations: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            provider: { type: 'string', example: 'spotify' },
                            provider_name: { type: 'string', example: 'Spotify', description: 'Readable provider name with capitalization' },
                            connected: { type: 'boolean', example: true },
                            lastSyncedAt: { type: 'string', format: 'date-time', example: '2025-01-15T10:30:00Z', nullable: true },
                            details: { type: 'object', nullable: true }
                        }
                    }
                },
                totalIntegrations: { type: 'number', example: 9 },
                connectedIntegrations: { type: 'number', example: 3 }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid request parameters',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Internal server error',
        type: IntegrationErrorResponseDto
    })
    async getAllStatuses(
        @Query('userId') userId: string,
        @CurrentUser() user: AuthenticatedUser,
    ) {
        return this.integrations.getAllStatuses(userId);
    }

    // 5) Apple Health specific upload endpoint
    @Post('apple_health/upload')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Upload Apple Health data',
        description: 'Uploads health data from Apple Health app to the server'
    })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'User ID (must match authenticated user)', example: 'user-123-abc' },
                uploadToken: { type: 'string', description: 'Upload token from connect endpoint', example: 'token-abc-123' },
                healthData: {
                    type: 'object',
                    description: 'Health data from Apple Health',
                    example: { steps: 10000, heartRate: 75, workouts: [] }
                }
            },
            required: ['userId', 'uploadToken', 'healthData']
        }
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Health data uploaded successfully',
        schema: {
            type: 'object',
            properties: {
                success: { type: 'boolean', example: true },
                message: { type: 'string', example: 'Health data uploaded successfully' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid request - Missing required fields or invalid health data format',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token or upload token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Data validation failed or internal server error',
        type: IntegrationErrorResponseDto
    })
    async appleHealthUpload(
        @Body() payload: {
            userId: string;
            uploadToken: string;
            healthData: any;
        },
        @CurrentUser() user: AuthenticatedUser,
    ) {
        return this.integrations.handleAppleHealthUpload(
            payload.userId,
            payload.uploadToken,
            payload.healthData
        );
    }

    // // 6) Apple Music specific endpoints for MusicKit integration (deprecated - use callback endpoint)
    // @Post('apple_music/authorize')
    // @UseGuards(UserOwnershipGuard)
    // @ApiOperation({
    //     summary: 'Authorize Apple Music (Deprecated)',
    //     description: 'Deprecated: Use the standard callback endpoint instead. Authorizes Apple Music MusicKit integration'
    // })
    // @ApiBody({
    //     schema: {
    //         type: 'object',
    //         properties: {
    //             userId: { type: 'string', description: 'User ID (must match authenticated user)', example: 'user-123-abc' },
    //             musicUserToken: { type: 'string', description: 'MusicKit user token' },
    //             state: { type: 'string', description: 'Optional state parameter' }
    //         },
    //         required: ['userId', 'musicUserToken']
    //     }
    // })
    // @ApiResponse({
    //     status: HttpStatus.OK,
    //     description: 'Apple Music authorized successfully'
    // })
    // @ApiResponse({
    //     status: HttpStatus.BAD_REQUEST,
    //     description: 'Invalid callback payload',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.UNAUTHORIZED,
    //     description: 'Unauthorized - Invalid or missing Firebase token',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.FORBIDDEN,
    //     description: 'Forbidden - Cannot access another user\'s data',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.NOT_FOUND,
    //     description: 'Provider or user data not found',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.INTERNAL_SERVER_ERROR,
    //     description: 'Data sync failed',
    //     type: IntegrationErrorResponseDto
    // })
    // @ApiResponse({
    //     status: HttpStatus.BAD_GATEWAY,
    //     description: 'Provider API error',
    //     type: IntegrationErrorResponseDto
    // })
    // async appleMusicAuthorize(
    //     @Body() payload: {
    //         userId: string;
    //         musicUserToken: string;
    //         state?: string;
    //     },
    //     @CurrentUser() user: AuthenticatedUser,
    // ) {
    //     // Use the standard callback flow with user data
    //     const callbackPayload = {
    //         music_user_token: payload.musicUserToken,
    //         state: payload.state || `apple-music-${payload.userId}-${Date.now()}`,
    //     };
    //     return this.integrations.handleCallbackWithUserData(IntegrationProviderName.APPLE_MUSIC, callbackPayload);
    // }

    // 7) Get integration configuration for mobile apps
    @Get(':provider/config')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Get integration configuration',
        description: 'Retrieves configuration details for mobile app integration (client IDs, scopes, etc.)'
    })
    @ApiParam({
        name: 'provider',
        description: 'Integration provider name',
        example: 'spotify'
    })
    @ApiQuery({
        name: 'userId',
        required: true,
        description: 'User ID (must match authenticated user)',
        example: 'user-123-abc'
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Configuration retrieved successfully',
        schema: {
            type: 'object',
            properties: {
                clientId: { type: 'string', example: 'client-id-123' },
                scopes: { type: 'array', items: { type: 'string' }, example: ['user-read-email', 'user-top-read'] },
                redirectUri: { type: 'string', example: 'https://api.example.com/callback' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid request parameters',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Configuration error - Missing required configuration',
        type: IntegrationErrorResponseDto
    })
    async getConfig(
        @Param('provider') providerParam: string,
        @Query('userId') userId: string,
        @CurrentUser() user: AuthenticatedUser,
    ) {
        const provider = providerParam as IntegrationProviderName;
        return this.integrations.getIntegrationConfig(provider, userId);
    }

    // 8) Fetch user data for already connected integrations (with fresh sync)
    @Post(':provider/data')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Get user integration data',
        description: 'Fetches user data from an already connected integration. Optionally forces a fresh sync.'
    })
    @ApiParam({
        name: 'provider',
        description: 'Integration provider name',
        example: 'spotify'
    })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'User ID (must match authenticated user)', example: 'user-123-abc' },
                forceSync: { type: 'boolean', description: 'Force a fresh sync', example: true }
            },
            required: ['userId']
        }
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'User integration data retrieved successfully'
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid request parameters',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found or integration not connected for this user',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.PRECONDITION_FAILED,
        description: 'User not connected to provider',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.TOO_MANY_REQUESTS,
        description: 'Rate limit exceeded',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Data sync failed or internal server error',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.BAD_GATEWAY,
        description: 'Provider API error',
        type: IntegrationErrorResponseDto
    })
    async getDataPost(
        @Param('provider') providerParam: string,
        @Body('userId') userId: string,
        @CurrentUser() user: AuthenticatedUser,
        @Body('forceSync') forceSync?: boolean,
    ) {
        const provider = providerParam as IntegrationProviderName;
        return this.integrations.getConnectedUserData(provider, userId, forceSync);
    }

    // 8) Disconnect from integration provider
    @Post(':provider/disconnect')
    @UseGuards(UserOwnershipGuard)
    @ApiOperation({
        summary: 'Disconnect from an integration provider',
        description: 'Disconnects a user from a third-party integration provider by deleting OAuth tokens and marking the integration as disconnected'
    })
    @ApiParam({
        name: 'provider',
        description: 'Integration provider name',
        enum: ['spotify', 'strava', 'plaid', 'apple_music', 'apple_health', 'goodreads', 'email_scraper', 'contact_list', 'location_services'],
        example: 'spotify'
    })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'User ID (must match authenticated user)', example: 'user-123-abc' }
            },
            required: ['userId']
        }
    })
    @ApiResponse({
        status: HttpStatus.OK,
        description: 'Successfully disconnected from the integration provider',
        schema: {
            type: 'object',
            properties: {
                statusCode: { type: 'number', example: 200 },
                connectionStatus: { type: 'string', example: 'disconnected' },
                message: { type: 'string', example: 'Successfully disconnected from spotify' }
            }
        }
    })
    @ApiResponse({
        status: HttpStatus.BAD_REQUEST,
        description: 'Invalid provider or userId, or user not connected to provider',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.UNAUTHORIZED,
        description: 'Unauthorized - Invalid or missing Firebase token',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.FORBIDDEN,
        description: 'Forbidden - Cannot access another user\'s data',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.NOT_FOUND,
        description: 'Provider not found - Unsupported integration provider',
        type: IntegrationErrorResponseDto
    })
    @ApiResponse({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        description: 'Internal server error during disconnection',
        type: IntegrationErrorResponseDto
    })
    async disconnect(
        @Param('provider') providerParam: string,
        @Body('userId') userId: string,
        @CurrentUser() user: AuthenticatedUser,
    ) {
        const provider = providerParam as IntegrationProviderName;
        return this.integrations.disconnect(provider, userId);
    }
}