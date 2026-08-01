import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

const TFL_API_BASE = 'https://api.tfl.gov.uk';
const APP_KEY = process.env.TFL_APP_KEY || '';
const API_TIMEOUT = parseInt(process.env.TFL_API_TIMEOUT || '30000', 10);

const tflClient = axios.create({
    baseURL: TFL_API_BASE,
    timeout: API_TIMEOUT,
    params: APP_KEY ? { app_key: APP_KEY } : {}
});

// Implement 300req/min Rate Limiting (210ms interval) to match Java TflRateLimiter
const MIN_REQUEST_INTERVAL_MS = 210;
let nextAvailableTime = Date.now();

tflClient.interceptors.request.use(async (config) => {
    const now = Date.now();
    if (now < nextAvailableTime) {
        const waitTime = nextAvailableTime - now;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        nextAvailableTime += MIN_REQUEST_INTERVAL_MS;
    } else {
        nextAvailableTime = now + MIN_REQUEST_INTERVAL_MS;
    }
    return config;
});

/**
 * TfL does not recognise this StopPoint id.
 *
 * Deliberately distinct from every other TfL failure: a 404 is permanent and
 * caused by the caller's id, while a 500/timeout/429 is transient and ours to
 * absorb. Conflating the two would make a TfL outage start 404ing perfectly
 * real stations, so only the 404 is ever turned into this.
 */
export class UnknownStationError extends Error {
    constructor(public readonly naptanId: string) {
        super(`TfL does not recognise station '${naptanId}'`);
        this.name = 'UnknownStationError';
    }
}

export class TflApiClient {
    /**
     * Get Transport Modes from TfL Meta API
     */
    static async getTransportModes(): Promise<any[]> {
        const response = await tflClient.get('/Journey/Meta/Modes');
        return response.data;
    }

    /**
     * Get Lines by Mode
     */
    static async getLinesByMode(mode: string): Promise<any[]> {
        const response = await tflClient.get(`/Line/Mode/${mode}`);
        return response.data;
    }

    /**
     * Get Line Route and branches
     */
    static async getLineRoute(lineId: string): Promise<any> {
        const response = await tflClient.get(`/Line/${lineId}/Route`);
        return response.data;
    }

    /**
     * Ordered stop sequence for a line + direction.
     * Returns orderedLineRoutes (branch arrays of naptanIds) and stations (id→name map).
     */
    static async getLineRouteSequence(lineId: string, direction: string): Promise<any> {
        const response = await tflClient.get(`/Line/${lineId}/Route/Sequence/${direction}`, {
            params: { serviceTypes: 'Regular' }
        });
        return response.data;
    }

    /**
     * Stop Points by Line
     */
    static async getStopPointsByLine(lineId: string): Promise<any[]> {
        const response = await tflClient.get(`/Line/${lineId}/StopPoints`);
        return response.data;
    }

    /**
     * Get Line Statuses by Mode
     */
    static async getLineStatuses(mode: string): Promise<any[]> {
        const response = await tflClient.get(`/Line/Mode/${mode}/Status`);
        return response.data;
    }

    /**
     * Get Real-time Arrivals for a Station
     */
    static async getArrivalsForStation(naptanId: string): Promise<any[]> {
        try {
            const response = await tflClient.get(`/StopPoint/${naptanId}/Arrivals`);
            return response.data || [];
        } catch (error: any) {
            // TfL's authoritative "no such StopPoint" (verified: a malformed id
            // returns 404, a real one 200). Propagated so callers can answer 404
            // instead of manufacturing an empty board and caching it under a
            // made-up name — which is what silently swallowing this used to do.
            if (error?.response?.status === 404) throw new UnknownStationError(naptanId);

            // Everything else stays tolerant, as before: an outage, timeout or
            // rate-limit must degrade to an empty board rather than turn every
            // station in the network into a 404.
            console.warn(`[TflApi] Failed to fetch arrivals for ${naptanId}: ${error.message}`);
            return [];
        }
    }

    /**
     * Get Live Arrival/Departure board for a Station (Elizabeth line and
     * London Overground only — TfL exposes no such feed for other modes).
     * Rail-style entries with scheduled/estimated departure times and the
     * true outbound destination, matching what tfl.gov.uk renders.
     */
    static async getArrivalDepartures(naptanId: string, lineIds: string[]): Promise<any[]> {
        try {
            const response = await tflClient.get(`/StopPoint/${naptanId}/ArrivalDepartures`, {
                params: { lineIds: lineIds.join(',') }
            });
            return response.data || [];
        } catch (error: any) {
            // Non-fatal: callers fall back to the countdown arrivals feed.
            console.warn(`[TflApi] Failed to fetch ArrivalDepartures for ${naptanId}: ${error.message}`);
            return [];
        }
    }

    /**
     * Get Nearby Stop Points (Stations and Bus Stops)
     */
    static async getNearbyStopPoints(lat: number, lon: number, radius: number): Promise<any[]> {
        const stopTypes = 'NaptanMetroStation,NaptanRailStation,NaptanBusStop';
        const response = await tflClient.get('/StopPoint', {
            params: { lat, lon, radius, stopTypes, useStopPointHierarchy: true }
        });
        // TfL returns { stopPoints: [...] } for this endpoint
        return response.data.stopPoints || [];
    }

    /**
     * Get Detailed Stop Point Info
     */
    static async getStopPoint(naptanId: string): Promise<any> {
        const response = await tflClient.get(`/StopPoint/${naptanId}`);
        return response.data;
    }
}
