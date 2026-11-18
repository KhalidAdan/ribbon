/**
 * The measurement build's ear (RIBBON_PROFILE=1): how loud the book is,
 * sample by sample, at two places in the player's audio graph. `arriving`
 * is what the audio elements hand over, `leaving` is what goes on to the
 * speakers after the gain that shuts a paused book's output. Nothing is
 * skipped between readings, so a chirp of a few milliseconds is counted.
 *
 * A line is logged for every second in which either place held sound, and
 * one more when both fall silent. It proves what a lid's opening does:
 * sound may arrive, and none may leave.
 */
export function logSoundLevels(ctx: AudioContext, sources: AudioNode[], gate: AudioNode, log: (line: string) => void): void {
  const arriving = peakOf(ctx, sources);
  const leaving = peakOf(ctx, [gate]);
  let wasSounding = false;
  setInterval(() => {
    const a = arriving.take();
    const l = leaving.take();
    const sounding = a.peak > 0 || l.peak > 0;
    if (sounding || wasSounding) {
      log(`sound level: arriving ${a.peak.toFixed(4)}, leaving ${l.peak.toFixed(4)} (${l.samples} samples, output ${ctx.state})`);
    }
    wasSounding = sounding;
  }, 1_000);
}

/** The loudest sample since last taken, of everything `from` plays, and how many samples that was. */
function peakOf(ctx: AudioContext, from: AudioNode[]): { take(): { peak: number; samples: number } } {
  let peak = 0;
  let samples = 0;
  // Every block of samples passes through here, unlike an analyser, which shows only the latest few.
  const ear = ctx.createScriptProcessor(1024, 2, 2);
  ear.onaudioprocess = (e) => {
    for (let c = 0; c < e.inputBuffer.numberOfChannels; c++) {
      const data = e.inputBuffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i]!);
        if (v > peak) peak = v;
      }
    }
    samples += e.inputBuffer.length;
  };
  for (const node of from) node.connect(ear);
  // It hears only while something downstream asks it for sound; what it passes on is silence.
  ear.connect(ctx.destination);
  return {
    take() {
      const taken = { peak, samples };
      peak = 0;
      samples = 0;
      return taken;
    },
  };
}
