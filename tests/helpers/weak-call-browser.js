export async function runWeakCall(profile) {
    const { CallController } = await import('/src/lib/call-controller.ts');
    const { generateIdentity } = await import('/src/lib/crypto.ts');
    const { CALL_CAPABILITY } = await import('/src/lib/call-types.ts');
    const { authenticatedMlsCallMembers, signCallIdentityAttestation, verifyCallIdentityAttestations } = await import('/src/lib/call-membership.ts');
    const { createCreatorMlsState, prepareCreatorWelcome, joinMlsGroup } = await import('/src/lib/mls.ts');
    const check = (value, label) => { if (!value) throw new Error(label); };
    const wait = async (predicate, label, limit = 10_000) => {
      const deadline = Date.now() + limit;
      while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      check(predicate(), typeof label === 'function' ? label() : label);
    };
    const [callerIdentity, calleeIdentity] = await Promise.all([generateIdentity(), generateIdentity()]);
    const members = [
      { ...callerIdentity.publicBundle, role: 'creator', status: 'active', joinProof: null, capabilities: [CALL_CAPABILITY] },
      { ...calleeIdentity.publicBundle, role: 'joiner', status: 'active', joinProof: null, capabilities: [CALL_CAPABILITY] },
    ];
    const common = {
      v: 3, roomId: crypto.randomUUID(), accessToken: 'unused', pairingSecret: '', creatorFingerprint: '',
      lastSeq: 0, createdAt: new Date().toISOString(), protocol: 'mls-rfc9420',
      members,
    };
    const callerVault = { ...common, role: 'creator', identity: callerIdentity, mls: await createCreatorMlsState(common.roomId, callerIdentity, members) };
    callerVault.mls = await prepareCreatorWelcome(callerVault);
    const calleeVault = { ...common, role: 'joiner', identity: calleeIdentity, mls: { protocol: 'mls-rfc9420', phase: 'awaiting-welcome' } };
    calleeVault.mls = await joinMlsGroup(calleeVault, callerVault.mls.pendingWelcome);
    callerVault.mls.pendingWelcome = undefined;
    await Promise.all([authenticatedMlsCallMembers(callerVault), authenticatedMlsCallMembers(calleeVault)]);
    const callIdentities = await Promise.all([signCallIdentityAttestation(callerVault), signCallIdentityAttestation(calleeVault)]);

    const { CallSignalQueue } = await import('/src/lib/call-signal-queue.ts');
    let online = true, caller, callee, frames = 0, incomingTransitions = 0;
    const processed = new Set(), timers = new Set();
    const delay = ms => new Promise(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timers.add(timer); });
    const queues = [];
    const options = vault => ({ getVault: () => vault,
      getIceConfig: async signal => { if (profile.configDelay) await delay(profile.configDelay); signal?.throwIfAborted(); return { iceServers: [], iceTransportPolicy: 'all', relayConfigured: false, verifiedPeerIds: await verifyCallIdentityAttestations(vault, callIdentities) }; },
      onChange: (() => { let previous; return state => { if (state.phase === 'incoming' && previous !== 'incoming') incomingTransitions++; previous = state.phase; }; })(), onPermissionChange: () => {},
    });
    const queueFor = recipient => {
      let attempts = 0;
      const queue = new CallSignalQueue(envelope => {
        if (!online) return false;
        frames += 1;
        const sample = (++attempts * 37) % 100;
        // Deterministic loss of signaling datagrams/acks; this does not emulate RTP packet loss.
        if (sample < (profile.loss ?? 0) * 100) return true;
        void delay(profile.latency ?? 0).then(() => {
          if (!online) return;
          if (!processed.has(envelope.eventId)) {
            processed.add(envelope.eventId);
            if (envelope.action === 'accept') {
              const event = { type: 'call-state', callId: envelope.callId, state: 'accepted', acceptedBy: envelope.senderId };
              caller.serverEvent(event); callee.serverEvent(event);
            }
            void recipient().receive(envelope);
          }
          // Simulate an acknowledgement dropped on selected writes; retry remains the original event.
          if (sample >= (profile.ackLoss ?? 0) * 100) queue.acknowledge(envelope.callId, envelope.eventId);
        });
        return true;
      });
      queues.push(queue); return queue;
    };
    const callerQueue = queueFor(() => callee), calleeQueue = queueFor(() => caller);
    caller = new CallController({ ...options(callerVault), send: frame => callerQueue.send(frame), cancelSignals: id => callerQueue.cancel(id) });
    callee = new CallController({ ...options(calleeVault), send: frame => calleeQueue.send(frame), cancelSignals: id => calleeQueue.cancel(id) });
    const started = performance.now();
    try {
      await caller.start('video');
      await wait(() => callee.state.phase === 'incoming', 'Delayed invite missing', 15_000);
      await callee.accept();
      await wait(() => caller.state.phase === 'connected' && callee.state.phase === 'connected', 'Native media did not connect', 20_000);
      const firstConnectMs = Math.round(performance.now() - started);
      const streams = [caller.state.localStream, callee.state.localStream];
      const audio = streams.flatMap(stream => stream.getAudioTracks());
      let observedPacketLoss = null;
      if (profile.network) {
        await delay(4000);
        const reports = await caller.pc.getStats();
        let lost = 0, received = 0;
        reports.forEach(report => { if (report.type === 'inbound-rtp') { lost += Math.max(0, report.packetsLost ?? 0); received += report.packetsReceived ?? 0; } });
        check(received > 0, 'No received media under CDP impairment');
        observedPacketLoss = lost / (lost + received);
      }
      if (profile.disconnectMs) {
        online = false; caller.setConnection(false); callee.setConnection(false);
        await delay(profile.disconnectMs);
        check(caller.active && callee.active, 'Short signaling interruption ended media');
        check(audio.every(track => track.readyState === 'live' && track.enabled), 'Signaling interruption stopped audio');
        online = true; caller.setConnection(true); callee.setConnection(true); queues.forEach(queue => queue.flush(true));
      }
      if (profile.quality) {
        // Inject only the stats input; native media continues. Synthetic metrics are never presented as real RTP shaping.
        const pc = caller.pc, originalStats = pc.getStats.bind(pc);
        let poor = true, counter = 0;
        pc.getStats = async () => {
          const map = new Map(await originalStats());
          for (const [id, report] of map) {
            if (report.type === 'candidate-pair') map.set(id, { ...report, currentRoundTripTime: poor ? 0.9 : 0.05, availableOutgoingBitrate: poor ? 90_000 : 3_000_000 });
            if (report.type === 'remote-inbound-rtp') map.set(id, { ...report, fractionLost: poor ? (profile.uplinkLoss ?? 0.2) : 0, roundTripTime: poor ? 0.9 : 0.05 });
            if (report.type === 'inbound-rtp') map.set(id, { ...report, packetsReceived: ++counter * 1000, packetsLost: poor ? counter * 200 : counter * 0, jitter: poor ? 0.13 : 0.01 });
          }
          return map;
        };
        for (let i = 0; i < 15; i++) await caller.inspectQuality(caller.context);
        check(caller.state.quality === 'audio-only', 'Video did not degrade to audio-only');
        check(audio.every(track => track.enabled && track.readyState === 'live'), 'Quality adaptation lost audio');
        poor = false;
        for (let i = 0; i < 8; i++) await caller.inspectQuality(caller.context);
        check(caller.state.quality === 'recovering' && caller.state.cameraEnabled, 'Low-quality video did not resume');
        for (let i = 0; i < 24; i++) await caller.inspectQuality(caller.context);
        check(caller.state.quality === 'good', 'Video failed gradual restoration');
        pc.getStats = originalStats;
      }
      check(audio.every(track => track.readyState === 'live'), 'Audio ended unexpectedly');
      const callId = caller.state.callId;
      await caller.hangup(); await wait(() => !callee.active, 'Hangup did not propagate');
      check(streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')), 'Capture leaked');
      caller.dismiss(); callee.dismiss();
      await caller.start('audio'); await wait(() => callee.state.phase === 'incoming', 'Next call failed');
      check(caller.state.callId !== callId, 'Old call identity reused');
      await caller.hangup(); await wait(() => !callee.active, 'Next hangup failed');
      check(incomingTransitions === 2, 'Duplicate invitation advanced the call state');
      return { name: profile.name, observedPacketLoss, connected: true, firstConnectMs, audioRetained: true, unexpectedEnd: false, duplicateStateAdvances: Math.max(0, incomingTransitions - 2), signalingTransmissions: frames, uniqueEvents: processed.size, tracksCleaned: true, nextCall: true };
    } finally {
      caller.destroy(); callee.destroy(); queues.forEach(queue => queue.close()); timers.forEach(clearTimeout); timers.clear();
    }
}
