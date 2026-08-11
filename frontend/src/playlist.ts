import type { Asset } from "./api";

/**
 * Preserve the server-built (possibly seasonally weighted) order.
 * Only rotate so we don't open on a recently shown photo when possible.
 */
export function buildPlaylist(
  assets: Asset[],
  recentIds: string[] = [],
): Asset[] {
  const playlist = [...assets];
  if (playlist.length < 2 || recentIds.length === 0) {
    return playlist;
  }

  const recent = new Set(recentIds);
  const preferred = playlist.findIndex((asset) => !recent.has(asset.id));
  if (preferred <= 0) {
    return playlist;
  }

  const [first] = playlist.splice(preferred, 1);
  playlist.unshift(first);
  return playlist;
}

/** Advance to the next asset; preserve order across cycles (no full reshuffle). */
export function advancePlaylist(
  playlist: Asset[],
  index: number,
  recentIds: string[],
): { playlist: Asset[]; index: number; recentIds: string[] } {
  if (playlist.length === 0) {
    return { playlist, index: 0, recentIds };
  }

  if (playlist.length === 1) {
    return {
      playlist,
      index: 0,
      recentIds: rememberRecent(recentIds, playlist[0].id, 1),
    };
  }

  const atEnd = index >= playlist.length - 1;
  if (!atEnd) {
    const nextIndex = index + 1;
    return {
      playlist,
      index: nextIndex,
      recentIds: rememberRecent(
        recentIds,
        playlist[nextIndex].id,
        recentWindow(playlist.length),
      ),
    };
  }

  // Start a new cycle without destroying server seasonal ordering.
  const currentId = playlist[index]?.id;
  const nextPlaylist = [...playlist];
  if (nextPlaylist[0]?.id === currentId) {
    const swapWith = nextPlaylist.findIndex((asset) => asset.id !== currentId);
    if (swapWith > 0) {
      [nextPlaylist[0], nextPlaylist[swapWith]] = [
        nextPlaylist[swapWith],
        nextPlaylist[0],
      ];
    }
  }

  return {
    playlist: nextPlaylist,
    index: 0,
    recentIds: rememberRecent(
      recentIds,
      nextPlaylist[0].id,
      recentWindow(nextPlaylist.length),
    ),
  };
}

export function retreatPlaylist(
  playlist: Asset[],
  index: number,
  recentIds: string[],
): { playlist: Asset[]; index: number; recentIds: string[] } {
  if (playlist.length === 0) {
    return { playlist, index: 0, recentIds };
  }

  const nextIndex = (index - 1 + playlist.length) % playlist.length;
  return {
    playlist,
    index: nextIndex,
    recentIds: rememberRecent(
      recentIds,
      playlist[nextIndex].id,
      recentWindow(playlist.length),
    ),
  };
}

function recentWindow(length: number): number {
  if (length <= 2) return 1;
  return Math.min(25, Math.max(2, Math.floor(length / 3)));
}

function rememberRecent(
  recentIds: string[],
  assetId: string,
  limit: number,
): string[] {
  const next = [assetId, ...recentIds.filter((id) => id !== assetId)];
  return next.slice(0, limit);
}
