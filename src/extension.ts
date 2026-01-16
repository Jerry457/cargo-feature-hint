import * as vscode from "vscode"
import axios from "axios"

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
            const crateName = getCrateName(document, position)
            if (!crateName) {
                return undefined
            }

            const features = await fetchCrateFeatures(crateName)
            const existingFeatures = getExistingFeatures(lineText)
            const filteredFeatures = features.filter(f => !existingFeatures.has(f))

            return filteredFeatures.map(f => {
                const item = new vscode.CompletionItem(f, vscode.CompletionItemKind.Property)
                item.detail = `feature of ${crateName}`
                return item
            })
        },
    }

    const disposable = vscode.languages.registerCompletionItemProvider(selector, provider, '"', "'")
    context.subscriptions.push(disposable)
}

function getCrateName(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const currentLine = document.lineAt(position.line).text

    // serde = { version = "1.0", features = ["
    const inlineMatch = currentLine.match(/^\s*([\w-]+)\s*=\s*\{/)
    if (inlineMatch) {
        return inlineMatch[1]
    }

    // [dependencies.tokio]
    // features = ["
    for (let i = position.line - 1; i >= 0; i--) {
        const line = document.lineAt(i).text.trim()
        // [dependencies.crate-name] or [dev-dependencies.crate-name]
        const tableMatch = line.match(/^\[(?:[a-z-]+\.)([\w-]+)\]/)
        if (tableMatch) {
            return tableMatch[1]
        }
        if (line.startsWith("[") && !line.includes("dependencies")) {
            break
        }
    }
    return undefined
}

function getExistingFeatures(lineText: string): Set<string> {
    const featuresMatch = lineText.match(/features\s*=\s*\[([^\]]*)\]/)
    if (!featuresMatch) return new Set()

    const content = featuresMatch[1]
    const existing = content.match(/["']([^"']+)["']/g) || []
    return new Set(existing.map(s => s.replace(/["']/g, "")))
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
