import AVFoundation
import MediaToolbox

/// Every book at the same loudness, as the desktop plays them
/// (packages/core/src/loudness.ts, `gainDb`, mirrored here as `Resume`
/// mirrors resume.ts): the server measures each book once, and the gain
/// brings it to the library's loudness without clipping, so nobody reaches
/// for the volume between narrators.
enum Loudness {
    /// EBU R128 integrated loudness every book is brought to.
    static let targetLufs = -18.0
    /// True-peak ceiling after the gain, in dBTP.
    static let peakCeilingDbtp = -1.0
    /// Never louder or quieter than this.
    static let maxGainDb = 12.0

    /// The gain in dB that brings a book measured at `integratedLufs` to the target without its peaks clipping.
    static func gainDb(integratedLufs: Double, truePeakDbtp: Double?) -> Double {
        var gain = targetLufs - integratedLufs
        if let truePeakDbtp { gain = min(gain, peakCeilingDbtp - truePeakDbtp) }
        gain = min(maxGainDb, max(-maxGainDb, gain))
        return (gain * 100).rounded() / 100
    }

    /// The gain as a factor on each sample.
    static func linear(_ db: Double) -> Float {
        Float(pow(10, db / 20))
    }

    /// An audio mix that multiplies every sample of a file's sound by `gain`, for its player item. Apple's player
    /// volume stops at 1, so a quiet book can only be brought up here, on the samples on their way out.
    static func mix(for track: AVAssetTrack, gain: Float) -> AVAudioMix? {
        let box = Unmanaged.passRetained(GainBox(gain: gain))
        var callbacks = MTAudioProcessingTapCallbacks(
            version: kMTAudioProcessingTapCallbacksVersion_0,
            clientInfo: box.toOpaque(),
            init: { _, clientInfo, storage in storage.pointee = clientInfo },
            finalize: { tap in Unmanaged<GainBox>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release() },
            prepare: { tap, _, format in
                // Apple's player hands a tap floats; anything else passes through as it came.
                let f = format.pointee
                let box = Unmanaged<GainBox>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                box.floats = f.mFormatID == kAudioFormatLinearPCM && f.mFormatFlags & kAudioFormatFlagIsFloat != 0 && f.mBitsPerChannel == 32
                log.info("a file plays at \(box.gain, format: .fixed(precision: 2))× its loudness\(box.floats ? "" : ": its samples aren't floats, so as it came", privacy: .public)")
            },
            unprepare: nil,
            process: { tap, frames, _, buffers, framesOut, flagsOut in
                guard MTAudioProcessingTapGetSourceAudio(tap, frames, buffers, flagsOut, nil, framesOut) == noErr else { return }
                let box = Unmanaged<GainBox>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
                guard box.floats, box.gain != 1 else { return }
                for buffer in UnsafeMutableAudioBufferListPointer(buffers) {
                    guard let data = buffer.mData else { continue }
                    let samples = data.assumingMemoryBound(to: Float.self)
                    for i in 0..<Int(buffer.mDataByteSize) / MemoryLayout<Float>.size { samples[i] *= box.gain }
                }
            }
        )
        var tap: MTAudioProcessingTap?
        guard MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap) == noErr, let tap else {
            box.release()
            return nil
        }
        let input = AVMutableAudioMixInputParameters(track: track)
        input.audioTapProcessor = tap
        let mix = AVMutableAudioMix()
        mix.inputParameters = [input]
        return mix
    }
}

/// What a file's tap knows: the gain, and whether the samples are floats it can multiply.
private final class GainBox {
    let gain: Float
    var floats = false

    init(gain: Float) {
        self.gain = gain
    }
}
