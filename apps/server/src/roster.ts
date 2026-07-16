import type { PeerInfo } from '@game/shared';

/** Tracks who is currently connected to the room. */
export class Roster {
  private peers = new Map<string, PeerInfo>();

  add(info: PeerInfo): void {
    this.peers.set(info.id, info);
  }

  remove(id: string): void {
    this.peers.delete(id);
  }

  has(id: string): boolean {
    return this.peers.has(id);
  }

  list(): PeerInfo[] {
    return [...this.peers.values()];
  }
}
