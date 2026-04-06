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
            // Log warning but return empty list - avoids 500ing on invalid IDs
            console.warn(`[TflApi] Failed to fetch arrivals for ${naptanId}: ${error.message}`);
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
