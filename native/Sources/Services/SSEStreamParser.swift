import Foundation
import os

enum GhostStreamEvent {
    case message(GhostMessage)
    case done
}

struct RawSSEEvent {
    let id: String?
    let name: String
    let data: String
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
                    for try await event in parseRaw(bytes: bytes, ghostName: ghostName) {
                        switch event.name {
                        case "done":
                            continuation.yield(.done)
                            continuation.finish()
                            return
                        case "error":
                            let errorMessage = sseErrorMessage(from: event.data)
                            continuation.finish(throwing: GhostboxClientError.requestFailed(statusCode: 0, message: errorMessage))
                            return
                        case "message":
                            guard !event.data.isEmpty else { continue }
                            let message = try decoder.decode(GhostMessage.self, from: Data(event.data.utf8))
                            continuation.yield(.message(message))
                        default:
                            continue
                        }
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

    func parseRaw(
        bytes: URLSession.AsyncBytes,
        ghostName: String
    ) -> AsyncThrowingStream<RawSSEEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var iterator = bytes.makeAsyncIterator()
                    var lineBuffer = Data()
                    var currentEvent: String?
                    var currentId: String?
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
                                currentId: &currentId,
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
                            currentId: &currentId,
                            dataLines: &dataLines,
                            continuation: continuation
                        ) {
                            return
                        }
                    }

                    if try handleSSEEvent(
                        name: currentEvent,
                        id: currentId,
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
        currentId: inout String?,
        dataLines: inout [String],
        continuation: AsyncThrowingStream<RawSSEEvent, Error>.Continuation
    ) throws -> Bool {
        if line.isEmpty {
            if try handleSSEEvent(
                name: currentEvent,
                id: currentId,
                dataLines: dataLines,
                continuation: continuation
            ) {
                return true
            }

            currentEvent = nil
            currentId = nil
            dataLines.removeAll(keepingCapacity: true)
            return false
        }

        if line.hasPrefix(":") {
            return false
        }

        if let eventName = sseValue(for: "event:", in: line) {
            currentEvent = eventName.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if let eventId = sseValue(for: "id:", in: line) {
            currentId = eventId.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if let data = sseValue(for: "data:", in: line) {
            dataLines.append(data)
        }

        return false
    }

    private func handleSSEEvent(
        name: String?,
        id: String?,
        dataLines: [String],
        continuation: AsyncThrowingStream<RawSSEEvent, Error>.Continuation
    ) throws -> Bool {
        let eventName = name ?? "message"

        let payload = dataLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if payload.isEmpty && eventName != "done" {
            return false
        }

        continuation.yield(RawSSEEvent(id: id, name: eventName, data: payload))

        if eventName == "done" {
            continuation.finish()
            return true
        }

        return false
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
