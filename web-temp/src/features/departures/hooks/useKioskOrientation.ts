import { useState, useCallback, useEffect } from 'react';

export type RotationAngle = 0 | 90 | 180 | 270;

const STORAGE_KEY = 'stationly_kiosk_rotation';

function isValidAngle(angle: number): angle is RotationAngle {
    return angle === 0 || angle === 90 || angle === 180 || angle === 270;
}

/**
 * Persists rotation across localStorage, sessionStorage, and persistent cookies
 * so that kiosk displays and smart TVs maintain orientation across reboots,
 * automatic updates, or page refreshes.
 */
function saveRotation(rotation: RotationAngle) {
    if (typeof window === 'undefined') return;

    // 1. localStorage
    try {
        localStorage.setItem(STORAGE_KEY, String(rotation));
    } catch {
        // localStorage restricted or disabled
    }

    // 2. sessionStorage
    try {
        sessionStorage.setItem(STORAGE_KEY, String(rotation));
    } catch {
        // ignore
    }

    // 3. Persistent cookie (365 days)
    try {
        document.cookie = `${STORAGE_KEY}=${rotation}; path=/; max-age=31536000; SameSite=Lax`;
    } catch {
        // ignore
    }
}

/**
 * Reads cached rotation preference from storage/cookies.
 */
function loadSavedRotation(): RotationAngle | null {
    if (typeof window === 'undefined') return null;

    // 1. Check localStorage
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved !== null) {
            const r = Number(saved);
            if (isValidAngle(r)) return r;
        }
    } catch {
        // ignore
    }

    // 2. Check sessionStorage
    try {
        const saved = sessionStorage.getItem(STORAGE_KEY);
        if (saved !== null) {
            const r = Number(saved);
            if (isValidAngle(r)) return r;
        }
    } catch {
        // ignore
    }

    // 3. Check cookies
    try {
        const match = document.cookie.match(new RegExp(`(?:^|; )${STORAGE_KEY}=([0-9]+)`));
        if (match) {
            const r = Number(match[1]);
            if (isValidAngle(r)) return r;
        }
    } catch {
        // ignore
    }

    return null;
}

/**
 * Manages display rotation for TVs and digital totems in any physical orientation.
 *
 * Persisted in storage/cache (`stationly_kiosk_rotation`) so TV reboots and page
 * refreshes retain orientation, with support for an explicit `?rotate=` URL parameter.
 */
export function useKioskOrientation(searchParams?: string) {
    const [rotation, setRotation] = useState<RotationAngle>(() => {
        if (typeof window === 'undefined') return 0;

        // 1. Check URL param ONLY if explicitly provided in query (e.g. ?rotate=90)
        if (searchParams) {
            const params = new URLSearchParams(searchParams);
            if (params.has('rotate')) {
                const r = Number(params.get('rotate'));
                if (isValidAngle(r)) return r;
            }
        }

        // 2. Check persistent cache (localStorage, sessionStorage, cookie)
        const saved = loadSavedRotation();
        if (saved !== null) return saved;

        return 0;
    });

    // Save to persistent storage whenever rotation changes
    useEffect(() => {
        saveRotation(rotation);
    }, [rotation]);

    // Sync ONLY if URL query explicitly provides or changes 'rotate' parameter
    useEffect(() => {
        if (!searchParams) return;
        const params = new URLSearchParams(searchParams);
        if (params.has('rotate')) {
            const r = Number(params.get('rotate'));
            if (isValidAngle(r)) {
                setRotation(r);
            }
        }
    }, [searchParams]);

    const rotateNext = useCallback(() => {
        setRotation(prev => {
            const next = ((prev + 90) % 360) as RotationAngle;
            return next;
        });
    }, []);

    // Listen for 'r' key to rotate for quick remote / keyboard control
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
            if (tag === 'input' || tag === 'textarea') return;

            if (e.key === 'r' || e.key === 'R') {
                e.preventDefault();
                rotateNext();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [rotateNext]);

    // Effective portrait mode considers both physical screen aspect ratio and current rotation
    const [isPortrait, setIsPortrait] = useState(() => {
        if (typeof window === 'undefined') return rotation === 90 || rotation === 270;
        const isRotated = rotation === 90 || rotation === 270;
        const effectiveW = isRotated ? window.innerHeight : window.innerWidth;
        const effectiveH = isRotated ? window.innerWidth : window.innerHeight;
        return effectiveW <= effectiveH;
    });

    useEffect(() => {
        const update = () => {
            const isRotated = rotation === 90 || rotation === 270;
            const effectiveW = isRotated ? window.innerHeight : window.innerWidth;
            const effectiveH = isRotated ? window.innerWidth : window.innerHeight;
            setIsPortrait(effectiveW <= effectiveH);
        };
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, [rotation]);

    return {
        rotation,
        rotateNext,
        isPortrait,
    };
}
