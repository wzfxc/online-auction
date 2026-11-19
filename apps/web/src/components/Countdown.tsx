'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { serverNowMs } from '@/lib/clock';
import { splitRemaining } from '@/lib/format';

export function Countdown({
  endsAt,
  endedLabel,
  className = '',
}: {
  endsAt: string | null;
  endedLabel?: string;
  className?: string;
}) {
  const tPlurals = useTranslations('plurals');
  const tLot = useTranslations('lot');
  const [nowMs, setNowMs] = useState<number>(() => serverNowMs());

  useEffect(() => {
    setNowMs(serverNowMs());
    const id = window.setInterval(() => setNowMs(serverNowMs()), 1000);
    return () => window.clearInterval(id);
  }, [endsAt]);

  const parts = splitRemaining(endsAt, nowMs);
  if (parts.ended) {
    return <span className={`font-medium text-slate-600 ${className}`}>{endedLabel ?? tLot('ended')}</span>;
  }

  const tokens: string[] = [];
  if (parts.days > 0) tokens.push(tPlurals('days', { count: parts.days }));
  if (parts.hours > 0 || parts.days > 0) tokens.push(tPlurals('hours', { count: parts.hours }));
  tokens.push(tPlurals('minutes', { count: parts.minutes }));
  tokens.push(tPlurals('seconds', { count: parts.seconds }));

  const urgent = parts.days === 0 && parts.hours === 0 && parts.minutes < 5;
  return (
    <span
      data-testid="lot-countdown"
      className={`font-mono font-semibold tabular-nums ${urgent ? 'text-rose-600' : 'text-emerald-700'} ${className}`}
    >
      {tokens.join(' ')}
    </span>
  );
}
