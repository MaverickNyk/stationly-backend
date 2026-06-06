import { activeEnv } from '@/lib/env';

/**
 * Slim top strip announcing the deployment environment — mirrors the
 * StationlyUI `StagingBanner` (pulsing orange "⚠ STAGING ENVIRONMENT").
 * Shown for staging only; production renders nothing so the prod console
 * looks clean.
 */
export default function EnvBanner() {
  if (activeEnv() !== 'staging') return null;
  return (
    <div className="env-banner staging">
      <span>⚠&nbsp;&nbsp;STAGING ENVIRONMENT</span>
    </div>
  );
}
