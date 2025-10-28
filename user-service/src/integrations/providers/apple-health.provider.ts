import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationProvider, IntegrationProviderName, ConnectResponse, CallbackPayload } from '../types';
import { IntegrationPersistence } from '../persistence';
import { PrismaService } from '@traeta/prisma';
import { TokenStore } from '../token-store';
import {
    ConfigurationException,
    InvalidCallbackException,
    InvalidTokenException,
    DataSyncException,
} from '../exceptions/integration.exceptions';
import { ACTIVE_CONDITION, DATA_TYPE, REC_SEQ, STATUS } from '../../../constants';

interface AppleHealthData {
    workouts?: AppleHealthWorkout[];
    healthMetrics?: AppleHealthMetric[];
    steps?: AppleHealthSteps[];
    heartRate?: AppleHealthHeartRate[];
    sleep?: AppleHealthSleep[];
}

interface AppleHealthWorkout {
    id: string;
    workoutType: string;
    startDate: string;
    endDate: string;
    duration: number; // in minutes
    totalEnergyBurned?: number; // calories
    totalDistance?: number; // in meters
    metadata?: Record<string, any>;
}

interface AppleHealthMetric {
    id: string;
    type: string; // weight, height, body_fat_percentage, etc.
    value: number;
    unit: string;
    date: string;
}

interface AppleHealthSteps {
    id: string;
    date: string;
    stepCount: number;
    distance?: number; // in meters
}

interface AppleHealthHeartRate {
    id: string;
    date: string;
    value: number; // BPM
    context?: string; // resting, active, etc.
}

interface AppleHealthSleep {
    id: string;
    startDate: string;
    endDate: string;
    value: string; // asleep, awake, in_bed
    duration: number; // in minutes
}

@Injectable()
export class AppleHealthProvider implements IntegrationProvider {
    public readonly name = IntegrationProviderName.APPLE_HEALTH;
    private readonly logger = new Logger(AppleHealthProvider.name);

    constructor(
        private readonly db: PrismaService,
        private readonly persistence: IntegrationPersistence,
        private readonly tokens: TokenStore,
        private readonly configService: ConfigService,
    ) { }

    private getDefaultDays(): number {
        const days = this.configService.get<string>('APPLE_HEALTH_DEFAULT_DAYS');
        return days ? Number(days) : 30;
    }

    private getUploadEndpoint(): string | undefined {
        return this.configService.get<string>('APPLE_HEALTH_UPLOAD_ENDPOINT');
    }

    async createConnection(userId: string): Promise<ConnectResponse> {
        try {
            // Validate configuration
            const uploadEndpoint = this.getUploadEndpoint();
            if (!uploadEndpoint) {
                throw new ConfigurationException(
                    IntegrationProviderName.APPLE_HEALTH,
                    'Apple Health upload endpoint is not configured'
                );
            }

            // Apple Health uses device-based authorization
            // We generate a session token for secure data upload from the iOS app
            const state = `apple-health-${userId}-${Date.now()}`;

            // Create a temporary upload token for the mobile app to use
            const uploadToken = this.generateUploadToken(userId);

            await this.persistence.ensureIntegration('apple_health');

            // Store the upload token temporarily
            await this.tokens.set(userId, 'apple_health', {
                accessToken: uploadToken,
                expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
            });

            return {
                provider: this.name,
                state,
                // Return upload endpoint and token for mobile app
                redirectUrl: `applehealth://connect?uploadEndpoint=${encodeURIComponent(uploadEndpoint)}&uploadToken=${uploadToken}&userId=${userId}`
            };
        } catch (error) {
            this.logger.error(`Failed to create Apple Health connection for user ${userId}:`, error);

            // Re-throw custom exceptions
            if (error instanceof ConfigurationException) {
                throw error;
            }

            throw new ConfigurationException(
                IntegrationProviderName.APPLE_HEALTH,
                `Failed to create connection: ${error.message}`
            );
        }
    }

    async handleCallback(payload: CallbackPayload): Promise<void> {
        this.logger.log(`Apple Health callback payload received`);

        const { state, healthData, uploadToken } = payload;

        if (!state || !uploadToken) {
            throw new InvalidCallbackException(
                IntegrationProviderName.APPLE_HEALTH,
                'Missing required callback parameters: state and uploadToken are required'
            );
        }

        // Extract userId from state format: "apple-health-<userId>-<ts>"
        // Remove "apple-health-" prefix and "-<timestamp>" suffix
        if (!state.startsWith('apple-health-')) {
            throw new InvalidCallbackException(
                IntegrationProviderName.APPLE_HEALTH,
                'Invalid state format: unable to extract userId'
            );
        }

        const stateWithoutPrefix = state.replace(/^apple-health-/, '');
        const lastDashIndex = stateWithoutPrefix.lastIndexOf('-');
        const userId = lastDashIndex > 0 ? stateWithoutPrefix.substring(0, lastDashIndex) : stateWithoutPrefix;
        if (!userId) {
            throw new InvalidCallbackException(
                IntegrationProviderName.APPLE_HEALTH,
                'Invalid state format: unable to extract userId'
            );
        }

        // Verify upload token
        const storedToken = await this.tokens.get(userId, 'apple_health');
        if (!storedToken || storedToken.accessToken !== uploadToken) {
            throw new InvalidTokenException(
                IntegrationProviderName.APPLE_HEALTH
            );
        }

        // Check token expiry
        const now = Math.floor(Date.now() / 1000);
        if (storedToken.expiresAt && storedToken.expiresAt < now) {
            throw new InvalidTokenException(
                IntegrationProviderName.APPLE_HEALTH
            );
        }

        // Process health data if provided
        if (healthData) {
            await this.processHealthData(userId, healthData as AppleHealthData);
        }

        // Mark as connected
        const integration = await this.persistence.ensureIntegration('apple_health');
        await this.persistence.markConnected(userId, integration.integrationId);

        this.logger.log(`Apple Health connected successfully for user ${userId}`);
    }

    async sync(userId: string): Promise<{ ok: boolean; syncedAt?: Date; details?: any }> {
        try {
            // For Apple Health, sync is typically initiated by the mobile app
            // This method can be used to trigger a sync request or process uploaded data

            const integration = await this.persistence.ensureIntegration('apple_health');
            const defaultDays = this.getDefaultDays();
            const sinceDate =
                (await this.persistence.getLastSyncedAt(userId, integration.integrationId)) ??
                new Date(Date.now() - defaultDays * 24 * 60 * 60 * 1000);

            // Check if there's any pending data to process
            // In a real implementation, you might check for uploaded files or queued data

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
                    message: 'Apple Health sync completed',
                    since: sinceDate,
                    note: 'Data sync is typically initiated from the iOS app'
                }
            };
        } catch (error) {
            this.logger.error(`Apple Health sync failed for user ${userId}:`, error);

            // Re-throw custom exceptions
            if (error instanceof DataSyncException) {
                throw error;
            }

            throw new DataSyncException(
                IntegrationProviderName.APPLE_HEALTH,
                `Failed to sync Apple Health data: ${error.message}`
            );
        }
    }

    async status(userId: string): Promise<{ connected: boolean; lastSyncedAt?: Date | null; details?: any }> {
        const integration = await this.persistence.ensureIntegration('apple_health');
        const link = await this.db.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
        });

        const history = link
            ? await this.db.userIntegrationHistory.findFirst({
                where: { userIntegrationId: link.userIntegrationId, userIntegrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            })
            : null;

        const isConnected = !!link && link.status === STATUS.CONNECTED;

        // Generate a fresh upload token for connected users
        let uploadToken: string | undefined;
        if (isConnected) {
            uploadToken = this.generateUploadToken(userId);
            await this.tokens.set(userId, 'apple_health', {
                accessToken: uploadToken,
                expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
            });
        }

        return {
            connected: isConnected,
            lastSyncedAt: history?.lastSyncedAt ?? null,
            details: {
                integrationId: integration.integrationId,
                uploadEndpoint: this.getUploadEndpoint(),
                popularity: integration.popularity,
                uploadToken: uploadToken, // Include token for connected users
            }
        };
    }

    // Method to handle direct data upload from mobile app
    async handleDataUpload(userId: string, uploadToken: string, healthData: AppleHealthData): Promise<{ ok: boolean; message: string }> {
        try {
            // Verify upload token
            const storedToken = await this.tokens.get(userId, 'apple_health');
            if (!storedToken || storedToken.accessToken !== uploadToken) {
                throw new InvalidTokenException(
                    IntegrationProviderName.APPLE_HEALTH
                );
            }

            // Check token expiry
            const now = Math.floor(Date.now() / 1000);
            if (storedToken.expiresAt && storedToken.expiresAt < now) {
                throw new InvalidTokenException(
                    IntegrationProviderName.APPLE_HEALTH
                );
            }

            await this.processHealthData(userId, healthData);

            // Mark as connected and synced
            const integration = await this.persistence.ensureIntegration('apple_health');

            // Ensure user is marked as connected
            await this.persistence.markConnected(userId, integration.integrationId);

            // Now mark as synced
            const link = await this.db.userIntegrations.findFirst({
                where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
            });

            if (link) {
                await this.persistence.markSynced(link.userIntegrationId);
            }

            return { ok: true, message: 'Health data uploaded successfully (duplicates skipped/updated)' };
        } catch (error) {
            this.logger.error(`Failed to upload Apple Health data for user ${userId}:`, error);

            // Re-throw custom exceptions
            if (error instanceof InvalidTokenException) {
                throw error;
            }

            throw new DataSyncException(
                IntegrationProviderName.APPLE_HEALTH,
                `Failed to upload health data: ${error.message}`
            );
        }
    }

    private generateUploadToken(userId: string): string {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2);
        return `ah_${userId}_${timestamp}_${random}`;
    }

    private async processHealthData(userId: string, healthData: AppleHealthData): Promise<void> {
        this.logger.log(`Processing health data for user ${userId}`);

        // Process workouts
        if (healthData.workouts && healthData.workouts.length > 0) {
            await this.processWorkouts(userId, healthData.workouts);
        }

        // Process health metrics (weight, height, etc.)
        if (healthData.healthMetrics && healthData.healthMetrics.length > 0) {
            await this.processHealthMetrics(userId, healthData.healthMetrics);
        }

        // Process steps data
        if (healthData.steps && healthData.steps.length > 0) {
            await this.processStepsData(userId, healthData.steps);
        }

        // Process heart rate data
        if (healthData.heartRate && healthData.heartRate.length > 0) {
            await this.processHeartRateData(userId, healthData.heartRate);
        }

        // Process sleep data
        if (healthData.sleep && healthData.sleep.length > 0) {
            await this.processSleepData(userId, healthData.sleep);
        }
    }

    private async processWorkouts(userId: string, workouts: AppleHealthWorkout[]): Promise<void> {
        for (const workout of workouts) {
            const categoryName = this.mapWorkoutType(workout.workoutType);
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Activity', categoryName);

            const startTime = new Date(workout.startDate);
            const endTime = new Date(workout.endDate);

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `Workout | ${startTime.toISOString()} - ${endTime.toISOString()}`,
                {
                    startTime: startTime.toISOString(),
                    endTime: endTime.toISOString(),
                    durationMinutes: workout.duration,
                    calories: workout.totalEnergyBurned ?? null,
                    distance: workout.totalDistance ? workout.totalDistance / 1609.344 : null, // meters to miles
                    workoutType: workout.workoutType,
                    metadata: workout.metadata ?? {},
                    external: { provider: 'apple_health', id: workout.id, type: 'workout' },
                },
                {
                    startTime: DATA_TYPE.STRING,
                    endTime: DATA_TYPE.STRING,
                    durationMinutes: DATA_TYPE.NUMBER,
                    calories: DATA_TYPE.NUMBER,
                    distance: DATA_TYPE.NUMBER,
                    workoutType: DATA_TYPE.STRING,
                    metadata: {},
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private async processHealthMetrics(userId: string, metrics: AppleHealthMetric[]): Promise<void> {
        for (const metric of metrics) {
            const categoryName = this.mapMetricType(metric.type);
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Health', categoryName);

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `${categoryName} | Health Metric`,
                {
                    date: metric.date,
                    value: metric.value,
                    unit: metric.unit,
                    metricType: metric.type,
                    external: { provider: 'apple_health', id: metric.id, type: 'metric' },
                },
                {
                    date: DATA_TYPE.STRING,
                    value: DATA_TYPE.NUMBER,
                    unit: DATA_TYPE.STRING,
                    metricType: DATA_TYPE.STRING,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private async processStepsData(userId: string, stepsData: AppleHealthSteps[]): Promise<void> {
        for (const steps of stepsData) {
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Health', 'Steps');

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `Steps | ${steps.date}`,
                {
                    date: steps.date,
                    stepCount: steps.stepCount,
                    distance: steps.distance ? steps.distance / 1609.344 : null, // meters to miles
                    external: { provider: 'apple_health', id: steps.id, type: 'steps' },
                },
                {
                    date: DATA_TYPE.STRING,
                    stepCount: DATA_TYPE.NUMBER,
                    distance: DATA_TYPE.NUMBER,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private async processHeartRateData(userId: string, heartRateData: AppleHealthHeartRate[]): Promise<void> {
        for (const hr of heartRateData) {
            const categoryName = hr.context ? `Heart Rate (${hr.context})` : 'Heart Rate';
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Health', categoryName);

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `Heart Rate | ${hr.date}`,
                {
                    date: hr.date,
                    heartRate: hr.value,
                    context: hr.context ?? null,
                    external: { provider: 'apple_health', id: hr.id, type: 'heart_rate' },
                },
                {
                    date: DATA_TYPE.STRING,
                    heartRate: DATA_TYPE.NUMBER,
                    context: DATA_TYPE.STRING,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private async processSleepData(userId: string, sleepData: AppleHealthSleep[]): Promise<void> {
        for (const sleep of sleepData) {
            const categoryName = `Sleep (${sleep.value})`;
            const { list, userList, category } = await this.persistence.ensureListAndCategoryForUser(userId, 'Health', categoryName);

            const startTime = new Date(sleep.startDate);
            const endTime = new Date(sleep.endDate);

            await this.persistence.createListItem(
                list.listId,
                REC_SEQ.DEFAULT_RECORD,
                userList.userListId,
                REC_SEQ.DEFAULT_RECORD,
                category?.listCategoryId ?? null,
                REC_SEQ.DEFAULT_RECORD,
                `Sleep | ${sleep.startDate} - ${sleep.endDate}`,
                {
                    startTime: startTime.toISOString(),
                    endTime: endTime.toISOString(),
                    durationMinutes: sleep.duration,
                    sleepValue: sleep.value,
                    external: { provider: 'apple_health', id: sleep.id, type: 'sleep' },
                },
                {
                    startTime: DATA_TYPE.STRING,
                    endTime: DATA_TYPE.STRING,
                    durationMinutes: DATA_TYPE.NUMBER,
                    sleepValue: DATA_TYPE.STRING,
                    external: {
                        provider: DATA_TYPE.STRING,
                        id: DATA_TYPE.STRING,
                        type: DATA_TYPE.STRING
                    },
                }
            );
        }
    }

    private mapWorkoutType(workoutType: string): string {
        const typeMap: Record<string, string> = {
            'HKWorkoutActivityTypeRunning': 'Run',
            'HKWorkoutActivityTypeWalking': 'Walk',
            'HKWorkoutActivityTypeCycling': 'Bike',
            'HKWorkoutActivityTypeSwimming': 'Swim',
            'HKWorkoutActivityTypeYoga': 'Yoga',
            'HKWorkoutActivityTypeStrengthTraining': 'Strength',
            'HKWorkoutActivityTypeHiking': 'Hike',
            'HKWorkoutActivityTypeDancing': 'Dance',
            'HKWorkoutActivityTypeBasketball': 'Basketball',
            'HKWorkoutActivityTypeTennis': 'Tennis',
            'HKWorkoutActivityTypeGolf': 'Golf',
            'HKWorkoutActivityTypeSoccer': 'Soccer',
        };

        return typeMap[workoutType] || 'Other';
    }

    private mapMetricType(metricType: string): string {
        const typeMap: Record<string, string> = {
            'HKQuantityTypeIdentifierBodyMass': 'Weight',
            'HKQuantityTypeIdentifierHeight': 'Height',
            'HKQuantityTypeIdentifierBodyFatPercentage': 'Body Fat',
            'HKQuantityTypeIdentifierLeanBodyMass': 'Lean Body Mass',
            'HKQuantityTypeIdentifierBodyMassIndex': 'BMI',
            'HKQuantityTypeIdentifierBloodPressureSystolic': 'Blood Pressure (Systolic)',
            'HKQuantityTypeIdentifierBloodPressureDiastolic': 'Blood Pressure (Diastolic)',
            'HKQuantityTypeIdentifierRestingHeartRate': 'Resting Heart Rate',
            'HKQuantityTypeIdentifierVO2Max': 'VO2 Max',
        };

        return typeMap[metricType] || 'Other Health Metric';
    }

    async disconnect(userId: string): Promise<void> {
        this.logger.log(`Disconnecting Apple Health for user ${userId}`);

        // Note: Apple Health is a device-based integration that doesn't use OAuth
        // Data is uploaded directly from the user's iOS device using HealthKit
        // There are no tokens to revoke with Apple - the user controls access through iOS settings

        // Delete temporary upload tokens from our system
        await this.tokens.delete(userId, 'apple_health');

        // Mark user integration as disconnected
        const integration = await this.persistence.ensureIntegration('apple_health');
        const link = await this.db.userIntegrations.findFirst({
            where: { userId, userRecSeq: REC_SEQ.DEFAULT_RECORD, integrationId: integration.integrationId, integrationRecSeq: REC_SEQ.DEFAULT_RECORD },
        });

        if (link) {
            await this.db.userIntegrations.update({
                where: {
                    userIntegrationId_recSeq: {
                        userIntegrationId: link.userIntegrationId,
                        recSeq: REC_SEQ.DEFAULT_RECORD,
                    },
                },
                data: { status: STATUS.DISCONNECTED },
            });
        }

        this.logger.log(`Apple Health disconnect completed for user ${userId}`);
    }
}