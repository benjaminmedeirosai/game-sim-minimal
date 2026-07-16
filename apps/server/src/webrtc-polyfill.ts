// PeerJS is a browser library: it expects WebRTC + WebSocket to exist as
// globals. Node has neither, so we shim them BEFORE peerjs is imported.
// This module must be imported first (see index.ts) so the globals exist by
// the time peerjs evaluates.
import wrtc from '@roamhq/wrtc';
import { WebSocket } from 'ws';

const g = globalThis as unknown as Record<string, unknown>;

g.RTCPeerConnection = wrtc.RTCPeerConnection;
g.RTCSessionDescription = wrtc.RTCSessionDescription;
g.RTCIceCandidate = wrtc.RTCIceCandidate;

if (!g.WebSocket) g.WebSocket = WebSocket;

// peerjs sniffs the environment via navigator.userAgent; give it something
// benign so its browser-detection doesn't throw under Node.
if (!g.navigator) g.navigator = { userAgent: 'node' };
