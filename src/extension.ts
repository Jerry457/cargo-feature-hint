import * as vscode from "vscode"
import axios from "axios"
import * as fs from "fs"
import * as path from "path"

const featuresCache = new Map<string, string[]>()

export function activate(context: vscode.ExtensionContext) {
    const selector: vscode.DocumentFilter = { language: "toml", pattern: "**/Cargo.toml" }

    const provider: vscode.CompletionItemProvider = {
        async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
            const lineAt = document.lineAt(position)
            const lineText = lineAt.text
            const linePrefix = lineText.substring(0, position.character)

            // math features = [ ...
            if (!linePrefix.match(/features\s*=\s*\[[^\]]*["']$/)) {
                return undefined
            }

            const crateInfo = getCrateInfo(document, position)
            if (!crateInfo) return undefined

            let features: string[] = []
            if (crateInfo.path) {
                features = fetchLocalCrateFeatures(crateInfo.path)
            } else {
                features = await fetchCrateFeatures(crateInfo.crateName)
            }

            const existingFeatures = getExistingFeatures(lineText)
            const filteredFeatures = features.filter(f => !existingFeatures.has(f))

            return filteredFeatures.map(f => {
                const item = new vscode.CompletionItem(f, vscode.CompletionItemKind.Property)
                item.detail = crateInfo.path
                    ? `local feature of ${crateInfo.crateName}`
                    : `feature of ${crateInfo.crateName}`
                return item
            })
        },
    }

    const disposable = vscode.languages.registerCompletionItemProvider(selector, provider, '"', "'")
    context.subscriptions.push(disposable)
}

function getExistingFeatures(lineText: string): Set<string> {
    const featuresMatch = lineText.match(/features\s*=\s*\[([^\]]*)\]/)
    if (!featuresMatch) return new Set()

    const content = featuresMatch[1]
    const existing = content.match(/["']([^"']+)["']/g) || []
    return new Set(existing.map(s => s.replace(/["']/g, "")))
}

function getCrateInfo(
    document: vscode.TextDocument,
    position: vscode.Position,
): { crateName: string; path?: string } | undefined {
    const currentLine = document.lineAt(position.line).text
    const documentDir = path.dirname(document.uri.fsPath)

    // serde = { version = "1.0", path = "../serde", features = ["
    const inlineMatch = currentLine.match(/^\s*([\w-]+)\s*=\s*\{/)
    if (inlineMatch) {
        const crateName = inlineMatch[1]
        const pathMatch = currentLine.match(/path\s*=\s*["']([^"']+)["']/)
        if (pathMatch) {
            return { crateName, path: path.resolve(documentDir, pathMatch[1]) }
        }
        return { crateName }
    }

    // [dependencies.tokio]
    for (let i = position.line - 1; i >= 0; i--) {
        const line = document.lineAt(i).text.trim()
        const tableMatch = line.match(/^\[(?:[a-z-]+\.)([\w-]+)\]/)
        if (tableMatch) {
            const crateName = tableMatch[1]
            for (let j = i + 1; j < i + 10 && j < document.lineCount; j++) {
                const nextLine = document.lineAt(j).text.trim()
                if (nextLine.startsWith("[")) break
                const pathMatch = nextLine.match(/^path\s*=\s*["']([^"']+)["']/)
                if (pathMatch) {
                    return { crateName, path: path.resolve(documentDir, pathMatch[1]) }
                }
            }
            return { crateName }
        }
        if (line.startsWith("[") && !line.includes("dependencies")) break
    }

    return undefined
}

function fetchLocalCrateFeatures(cratePath: string): string[] {
    try {
        const tomlPath = path.join(cratePath, "Cargo.toml")
        if (!fs.existsSync(tomlPath)) return []

        const content = fs.readFileSync(tomlPath, "utf-8")
        const features: string[] = []
        let inFeaturesSection = false

        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim()
            if (trimmed === "[features]") {
                inFeaturesSection = true
                continue
            }
            if (inFeaturesSection && trimmed.startsWith("[")) {
                inFeaturesSection = false
                continue
            }

            if (inFeaturesSection) {
                const match = trimmed.match(/^([\w-]+)\s*=/)
                if (match) {
                    features.push(match[1])
                }
            }
        }
        return features
    } catch (e) {
        console.error("Failed to fetch features for local crate", e)
        return []
    }
}

async function fetchCrateFeatures(crateName: string): Promise<string[]> {
    if (featuresCache.has(crateName)) {
        return featuresCache.get(crateName)!
    }

    try {
        const response = await axios.get(`https://crates.io/api/v1/crates/${crateName}`, {
            headers: { "User-Agent": "cargo-feature-autocomplete" },
            timeout: 3000,
        })

        const versions = response.data.versions
        if (versions && versions.length > 0) {
            const features = Object.keys(versions[0].features || {})
            const filtered = features.filter(f => !f.startsWith("_"))

            featuresCache.set(crateName, filtered)
            return filtered
        }
    } catch (e) {
        console.error(`Failed to fetch features for ${crateName}`, e)
    }
    return []
}
