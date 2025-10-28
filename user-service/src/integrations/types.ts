import { Request } from 'express';

export enum IntegrationProviderName {
    PLAID = 'plaid',
    STRAVA = 'strava',
    APPLE_HEALTH = 'apple_health',
    APPLE_MUSIC = 'apple_music',
    SPOTIFY = 'spotify',
    EMAIL_SCRAPER = 'email_scraper',
    LOCATION_SERVICES = 'location_services',
    CONTACT_LIST = 'contact_list',
    GOODREADS = 'goodreads',
}

export type ConnectResponse = {
    // Provider name
    provider: string;
    // For OAuth providers, redirect the client to this URL
    redirectUrl?: string;
    // For solutions like Plaid Link, return a link token that the FE can use
    linkToken?: string;
    // Opaque state to correlate callbacks
    state?: string;
};

export type CallbackPayload = {
    code?: string; // OAuth authorization code
    state?: string; // Opaque state value
    error?: string;
    [key: string]: any;
};

export interface IntegrationProvider {
    readonly name: IntegrationProviderName;
    // Initiate connect for a user. Returns redirectUrl or linkToken.
    createConnection(userId: string): Promise<ConnectResponse>;
    // Handle provider callback (OAuth, link, webhooks, etc.)
    handleCallback(payload: CallbackPayload, req?: Request): Promise<void>;
    // Trigger data sync for a user
    sync(userId: string): Promise<{ ok: boolean; syncedAt?: Date; details?: any }>;
    // Return basic connection status for a user
    status(userId: string): Promise<{ connected: boolean; lastSyncedAt?: Date | null; details?: any }>;
    // Disconnect the integration for a user
    disconnect?(userId: string): Promise<void>;
}