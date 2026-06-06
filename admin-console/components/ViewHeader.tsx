'use client';

import { ENV_META, type EnvName } from '@/lib/env';

/**
 * Header strip for a data view: shows the (fixed) deployment environment and
 * any view actions (refresh, etc). No environment switching — the env is
 * decided by the deployment, not the user.
 */
export default function ViewHeader({
  env,
  label = 'Environment',
  children,
}: {
  env: EnvName;
  label?: string;
  children?: React.ReactNode;
}) {
  const tone = ENV_META[env].tone;
  return (
    <div className={`viewbar ${tone}`}>
      <div className="env-label">
        {label} <span className={`env-badge ${tone}`}>{ENV_META[env].label}</span>
      </div>
      <div className="view-actions">{children}</div>
    </div>
  );
}
