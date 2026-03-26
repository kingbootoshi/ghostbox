import AVFoundation
import Foundation

final class SoundManager {
    static let shared = SoundManager()

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private var buffers: [SoundEffect: AVAudioPCMBuffer] = [:]
    private var isReady = false

    enum SoundEffect: CaseIterable {
        case messageSent
        case messageReceived
        case notification
        case sessionNew
        case ghostWake
        case ghostKill
        case error
    }

    private static let sampleRate: Float = 44100
    private static let twoPi = Float.pi * 2

    private init() {
        let fmt = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: Double(Self.sampleRate),
            channels: 1,
            interleaved: false
        )!

        format = fmt

        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)

        do {
            try engine.start()
            isReady = true
        } catch {
            return
        }

        for effect in SoundEffect.allCases {
            buffers[effect] = renderEffect(effect)
        }
    }

    func play(_ effect: SoundEffect) {
        guard isReady, let buffer = buffers[effect] else { return }
        player.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
        if !player.isPlaying {
            player.play()
        }
    }

    private struct Layer {
        let hz: Float
        let amp: Float
        let decay: Float
        let delay: Float
    }

    private func pianoNote(_ fundamental: Float, _ amplitude: Float, _ duration: Float, _ brightness: Float, delay: Float = 0) -> [Layer] {
        [
            Layer(hz: fundamental, amp: amplitude, decay: 4 / duration, delay: delay),
            Layer(hz: fundamental * 2, amp: amplitude * 0.5 * brightness, decay: 6 / duration, delay: delay),
            Layer(hz: fundamental * 3, amp: amplitude * 0.25 * brightness, decay: 8 / duration, delay: delay),
            Layer(hz: fundamental * 4, amp: amplitude * 0.1 * brightness, decay: 12 / duration, delay: delay),
            Layer(hz: fundamental * 5, amp: amplitude * 0.05 * brightness, decay: 16 / duration, delay: delay),
        ]
    }

    private func renderLayers(_ layers: [Layer], duration: Float) -> AVAudioPCMBuffer? {
        let totalFrames = AVAudioFrameCount(Self.sampleRate * duration)

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: totalFrames) else {
            return nil
        }
        buffer.frameLength = totalFrames

        guard let channelData = buffer.floatChannelData?.pointee else { return nil }

        for layer in layers {
            var phase: Float = 0
            let phaseInc = Self.twoPi * layer.hz / Self.sampleRate
            let delayFrames = AVAudioFrameCount(Self.sampleRate * layer.delay)

            for frame in delayFrames..<totalFrames {
                let t = Float(frame - delayFrames) / Float(totalFrames - delayFrames)
                let envelope = layer.amp * expf(-layer.decay * t)
                channelData[Int(frame)] += envelope * sinf(phase)
                phase += phaseInc
                if phase > Self.twoPi { phase -= Self.twoPi }
            }
        }

        return buffer
    }

    private func renderSweep(startFreq: Float, endFreq: Float, duration: Float, amplitude: Float, decay: Float, curve: Float = 2) -> AVAudioPCMBuffer? {
        let totalFrames = AVAudioFrameCount(Self.sampleRate * duration)

        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: totalFrames) else {
            return nil
        }
        buffer.frameLength = totalFrames

        guard let channelData = buffer.floatChannelData?.pointee else { return nil }

        var phase: Float = 0

        for frame in 0..<totalFrames {
            let t = Float(frame) / Float(totalFrames)
            let freq = startFreq + (endFreq - startFreq) * powf(t, curve)
            let phaseInc = Self.twoPi * freq / Self.sampleRate
            let envelope = amplitude * expf(-decay * t)
            channelData[Int(frame)] = envelope * sinf(phase)
            phase += phaseInc
            if phase > Self.twoPi { phase -= Self.twoPi }
        }

        return buffer
    }

    private func renderEffect(_ effect: SoundEffect) -> AVAudioPCMBuffer? {
        switch effect {

        // 3-octave-leap: C5 to C6, bold and clear
        case .messageSent:
            return renderLayers(
                pianoNote(523, 0.09, 0.2, 0.55)
                + pianoNote(1047, 0.1, 0.2, 0.65, delay: 0.04),
                duration: 0.2
            )

        // 2-descending-pair: B5 to G5
        case .messageReceived:
            return renderLayers(
                pianoNote(988, 0.1, 0.25, 0.6)
                + pianoNote(784, 0.09, 0.25, 0.55, delay: 0.06),
                duration: 0.25
            )

        // 2-sparkle-arpeggio: E G B E ascending
        case .notification:
            return renderLayers(
                pianoNote(659, 0.12, 0.6, 0.8)
                + pianoNote(784, 0.11, 0.6, 0.7, delay: 0.08)
                + pianoNote(988, 0.1, 0.6, 0.7, delay: 0.16)
                + pianoNote(1319, 0.09, 0.6, 0.6, delay: 0.24),
                duration: 0.65
            )

        // 4-blank-slate: soft low C with overtone bloom
        case .sessionNew:
            var layers = pianoNote(262, 0.1, 0.4, 0.5)
            layers.append(Layer(hz: 784, amp: 0.03, decay: 8, delay: 0.08))
            return renderLayers(layers, duration: 0.4)

        // 4-quick-boot: sweep 330 to 990
        case .ghostWake:
            return renderSweep(startFreq: 330, endFreq: 990, duration: 0.25, amplitude: 0.22, decay: 6, curve: 1.8)

        // 5-hollow-chord: 440+330+220 layered
        case .ghostKill:
            return renderLayers([
                Layer(hz: 440, amp: 0.1, decay: 6 / 0.25, delay: 0),
                Layer(hz: 330, amp: 0.1, decay: 6 / 0.25, delay: 0),
                Layer(hz: 220, amp: 0.1, decay: 6 / 0.25, delay: 0),
            ], duration: 0.25)

        // 4-quick-drop: sweep 440 to 220
        case .error:
            return renderSweep(startFreq: 440, endFreq: 220, duration: 0.12, amplitude: 0.25, decay: 12, curve: 0.5)
        }
    }
}
