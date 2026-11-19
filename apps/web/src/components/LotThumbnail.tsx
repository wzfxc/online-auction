'use client';

import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@/lib/api';
import { useApp } from '@/lib/providers';

interface LotThumbnailProps {
  lotId: string;
  title: string;
  /** When provided by a batch parent query, per-card photo requests are skipped. */
  thumbnailUrl?: string | null;
  managed?: boolean;
}

export function LotThumbnail({ lotId, title, thumbnailUrl, managed = false }: LotThumbnailProps) {
  const { client, token } = useApp();

  const photosQuery = useQuery({
    queryKey: ['lot-photos-thumb', lotId, token],
    enabled: !managed,
    staleTime: 60_000,
    queryFn: async () => unwrap(await client.GET('/lots/{id}/photos', { params: { path: { id: lotId } } })),
  });

  const firstProcessed = photosQuery.data?.find((p) => p.status === 'processed') ?? photosQuery.data?.[0];

  const urlQuery = useQuery({
    queryKey: ['lot-photo-url', lotId, firstProcessed?.id, 'preview', token],
    enabled: !managed && Boolean(firstProcessed && firstProcessed.status === 'processed'),
    staleTime: 180_000,
    queryFn: async () =>
      unwrap(
        await client.GET('/lots/{id}/photos/{photoId}/url', {
          params: {
            path: { id: lotId, photoId: firstProcessed!.id },
            query: { variant: 'preview' },
          },
        }),
      ),
  });

  const resolvedUrl = managed ? (thumbnailUrl ?? null) : (urlQuery.data?.url ?? null);

  if (!resolvedUrl) {
    return (
      <div className="flex h-44 w-full items-center justify-center rounded-t-xl bg-slate-100 text-xs font-medium text-slate-400">
        {title.slice(0, 24)}
      </div>
    );
  }

  return (
    <img
      src={resolvedUrl}
      alt={title}
      className="h-44 w-full rounded-t-xl bg-slate-100 object-cover"
      loading="lazy"
    />
  );
}
