/**
 * Prediction cache module — the single in-memory store of current station
 * predictions, shared by the REST endpoint and the WebSocket stream.
 *
 * Import from this barrel, never from the files inside it, so the module's
 * internals stay free to change:
 *
 *     import { PredictionCache } from '../services/predictionCache';
 *
 * See ./README.md for the why, the data flow, and the tuning knobs.
 */
export { PredictionCache } from './PredictionCache';
export type {
    CachedPrediction,
    PredictionCacheOptions,
    PredictionCacheStats,
    PredictionSourceTag,
} from './types';
