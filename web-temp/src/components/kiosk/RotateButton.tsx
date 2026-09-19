import { useRef } from 'react';
import type { RotationAngle } from '../../features/departures/hooks/useKioskOrientation';

interface RotateButtonProps {
    rotation: RotationAngle;
    onRotate: () => void;
}

/**
 * Button to rotate kiosk display orientation in 90-degree steps (0° -> 90° -> 180° -> 270° -> 0°).
 * Enables running on portrait TVs, vertical totems, or upside-down displays.
 */
export function RotateButton({ rotation, onRotate }: RotateButtonProps) {
    const btnRef = useRef<HTMLButtonElement>(null);

    return (
        <button
            type="button"
            className="fs-btn fs-btn--rotate"
            ref={btnRef}
            onClick={onRotate}
            title={`Rotate screen: currently ${rotation}° (click to rotate 90°)`}
            aria-label={`Rotate screen: currently ${rotation} degrees. Click to rotate 90 degrees.`}
        >
            <span className="fs-btn__icon" aria-hidden="true">↻</span>
            {rotation !== 0 && <span className="fs-btn__badge">{rotation}°</span>}
        </button>
    );
}
