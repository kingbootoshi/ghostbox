import Foundation
import os

enum GhostStreamEvent {
    case message(GhostMessage)
    case done
}

struct SSEStreamParser {
    private static let logger = Logger(subsystem: "com.ghostbox.app", category: "network")

    private let decoder: JSONDecoder

    init(decoder: JSONDecoder = JSONDecoder()) {
        self.decoder = decoder
    }

    func parse(
        bytes: URLSession.AsyncBytes,
        ghostName: String
    ) -> AsyncThrowingStream<GhostStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var iterator = bytes.makeAsyncIterator()
                    var lineBuffer = Data()
                    var currentEvent: String?
                    var dataLines: [String] = []

                    while let byte = try await iterator.next() {
                        if Task.isCancelled {
                            Self.logger.info("SSE parser cancelled for ghost \(ghostName, privacy: .public).")
                            continuation.finish()
                            return
                        }

                        if byte == 0x0A {
                            let line = decodeSSELine(from: lineBuffer)
                            lineBuffer.removeAll(keepingCapacity: true)

                            if try processSSELine(
                                line,
                                currentEvent: &currentEvent,
                                dataLines: &dataLines,
                                continuation: continuation
                            ) {
                                return
                            }
                        } else {
                            lineBuffer.append(byte)
                        }
                    }

                    if !lineBuffer.isEmpty {
                        let line = decodeSSELine(from: lineBuffer)
                        if try processSSELine(
                            line,
                            currentEvent: &currentEvent,
                            dataLines: &dataLines,
                            continuation: continuation
                        ) {
                            return
                        }
                    }

                    if try handleSSEEvent(
                        name: currentEvent,
                        dataLines: dataLines,
                        continuation: continuation
                    ) {
                        return
                    }

                    continuation.finish()
                } catch is CancellationError {
                    Self.logger.info("SSE parser task cancelled for ghost \(ghostName, privacy: .public).")
                    continuation.finish()
                } catch {
                    Self.logger.error("SSE parser failed for ghost \(ghostName, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private func processSSELine(
        _ line: String,
        currentEvent: inout String?,
        dataLines: inout [String],
        continuation: AsyncThrowingStream<GhostStreamEvent, Error>.Continuation
    ) throws -> Bool {
        let renderedLine = line.isEmpty ? "<blank>" : line
        Self.logger.debug("SSE line: \(renderedLine, privacy: .public)")

        if line.isEmpty {
            if try handleSSEEvent(
                name: currentEvent,
                dataLines: dataLines,
                continuation: continuation
            ) {
                return true
            }

            currentEvent = nil
            dataLines.removeAll(keepingCapacity: true)
            return false
        }

        if line.hasPrefix(":") {
            return false
        }

        if let eventName = sseValue(for: "event:", in: line) {
            currentEvent = eventName.trimmingCharacters(in: .whitespacesAndNewlines)
            let renderedEvent = currentEvent ?? "<none>"
            Self.logger.debug("SSE event name: \(renderedEvent, privacy: .public)")
        } else if let data = sseValue(for: "data:", in: line) {
            dataLines.append(data)
            Self.logger.debug("SSE data: \(data, privacy: .public)")
        }

        return false
    }

    private func handleSSEEvent(
        name: String?,
        dataLines: [String],
        continuation: AsyncThrowingStream<GhostStreamEvent, Error>.Continuation
    ) throws -> Bool {
        let eventName = name ?? "message"
        Self.logger.debug("Handling SSE event '\(eventName, privacy: .public)' with \(dataLines.count) data line(s).")

        if eventName == "done" {
            continuation.yield(.done)
            continuation.finish()
            return true
        }

        if eventName == "error" {
            let payload = dataLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            let errorMessage = sseErrorMessage(from: payload)
            continuation.finish(throwing: GhostboxClientError.requestFailed(statusCode: 0, message: errorMessage))
            return true
        }

        guard eventName == "message" else {
            return false
        }

        let payload = dataLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !payload.isEmpty else {
            return false
        }

        do {
            let message = try decoder.decode(GhostMessage.self, from: Data(payload.utf8))
            Self.logger.debug("Decoded ghost message of type '\(message.type.rawValue, privacy: .public)'.")
            continuation.yield(.message(message))
            return false
        } catch {
            throw GhostboxClientError.decodingFailed(error)
        }
    }

    private func decodeSSELine(from data: Data) -> String {
        var lineData = data
        if lineData.last == 0x0D {
            lineData.removeLast()
        }
        return String(decoding: lineData, as: UTF8.self)
    }

    private func sseValue(for prefix: String, in line: String) -> String? {
        guard line.hasPrefix(prefix) else { return nil }

        var value = String(line.dropFirst(prefix.count))
        if value.first == " " {
            value.removeFirst()
        }
        return value
    }

    private func sseErrorMessage(from payload: String) -> String {
        guard !payload.isEmpty else {
            return "Ghost connection failed"
        }

        struct ErrorPayload: Decodable {
            let error: String
        }

        if let data = payload.data(using: .utf8),
           let decoded = try? decoder.decode(ErrorPayload.self, from: data),
           !decoded.error.isEmpty {
            return decoded.error
        }

        return payload
    }
}
