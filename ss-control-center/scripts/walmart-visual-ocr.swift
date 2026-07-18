#!/usr/bin/env swift

import AppKit
import Foundation
import ImageIO
import Vision

struct BoundingBox: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let bounding_box: BoundingBox
}

struct ImageResult: Codable {
    let path: String
    let width: Int
    let height: Int
    let observations: [TextObservation]
}

struct Output: Codable {
    let schema_version: String
    let engine: String
    let images: [ImageResult]
}

enum OcrError: Error, CustomStringConvertible {
    case missingImage(String)
    case decodeFailed(String)

    var description: String {
        switch self {
        case .missingImage(let path): return "image does not exist: \(path)"
        case .decodeFailed(let path): return "image decode failed: \(path)"
        }
    }
}

func recognize(path: String) throws -> ImageResult {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: url.path) else {
        throw OcrError.missingImage(path)
    }
    guard
        let source = CGImageSourceCreateWithURL(url as CFURL, nil),
        let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
        throw OcrError.decodeFailed(path)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["en-US"]
    request.usesLanguageCorrection = false
    request.minimumTextHeight = 0.003

    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
    try handler.perform([request])

    let observations = (request.results ?? []).compactMap { observation -> TextObservation? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        // Vision can return a box extending outside the crop when the detected
        // word itself is clipped at an edge. Discard that partial transcription
        // instead of clamping it and treating incomplete text as trusted OCR.
        guard
            box.minX >= 0,
            box.minY >= 0,
            box.width > 0,
            box.height > 0,
            box.maxX <= 1,
            box.maxY <= 1
        else { return nil }
        return TextObservation(
            text: candidate.string,
            confidence: candidate.confidence,
            bounding_box: BoundingBox(
                x: box.origin.x,
                y: box.origin.y,
                width: box.size.width,
                height: box.size.height
            )
        )
    }.sorted { left, right in
        let leftTop = left.bounding_box.y + left.bounding_box.height
        let rightTop = right.bounding_box.y + right.bounding_box.height
        if abs(leftTop - rightTop) > 0.01 { return leftTop > rightTop }
        return left.bounding_box.x < right.bounding_box.x
    }

    return ImageResult(
        path: url.standardizedFileURL.path,
        width: cgImage.width,
        height: cgImage.height,
        observations: observations
    )
}

let paths = Array(CommandLine.arguments.dropFirst())
guard !paths.isEmpty else {
    FileHandle.standardError.write(Data("usage: walmart-visual-ocr.swift IMAGE [IMAGE ...]\n".utf8))
    exit(2)
}

do {
    let output = Output(
        schema_version: "walmart-local-ocr/v1",
        engine: "apple-vision-accurate-literal",
        images: try paths.map(recognize)
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data = try encoder.encode(output)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    let nsError = error as NSError
    FileHandle.standardError.write(Data(
        "OCR failed: domain=\(nsError.domain) code=\(nsError.code) description=\(nsError.localizedDescription) info=\(nsError.userInfo)\n".utf8
    ))
    exit(1)
}
