import type { VaultWatchSettings, Priority } from '../types';

/**
 * Notification sound player.
 * Uses Web Audio API to generate a simple ping tone — no audio files needed.
 */
export class NotificationSound {
  private audioCtx: AudioContext | null = null;

  constructor(private settings: VaultWatchSettings) {}

  play(priority: Priority): void {
    if (!this.settings.soundEnabled || this.settings.doNotDisturb) return;

    try {
      if (!this.audioCtx) {
        this.audioCtx = new AudioContext();
      }

      const ctx = this.audioCtx;
      const now = ctx.currentTime;

      // High priority = two-tone ping, normal = single tone
      if (priority === 'high') {
        this.playTone(ctx, 880, now, 0.12);       // A5
        this.playTone(ctx, 1174.66, now + 0.15, 0.12); // D6
      } else {
        this.playTone(ctx, 660, now, 0.15);       // E5
      }
    } catch {
      // Audio not available (headless, restricted context)
    }
  }

  private playTone(ctx: AudioContext, freq: number, startTime: number, duration: number): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);

    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(this.settings.soundVolume * 0.3, startTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  destroy(): void {
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
