import * as vscode from "vscode"
import axios from "axios"
import * as fs from "fs"
import * as path from "path"

type FeatureInfo = {
    name: string
    enable: string[]
}

// <name@version, features>
const featuresCache = new Map<string, FeatureInfo[]>()

export function activate(context: vscode.ExtensionContext) {
    const selector: vscode.DocumentFilter = { language: "toml", pattern: "**/Cargo.toml" }

    const provider: vscode.CompletionItemProvider = {
        async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
            const lineAt = document.lineAt(position)
            const lineText = lineAt.text
            const linePrefix = lineText.substring(0, position.character)

            // math features = [ ...
            if (!linePrefix.match(/features\s*=\s*\[[^\]]*["']([^"']*)$/)) {
                return undefined
            }

            const crateInfo = getCrateInfo(document, position)
            if (!crateInfo) return undefined

            let features = []
            if (crateInfo.path) {
                features = fetchLocalCrateFeatures(crateInfo.path)
            } else {
                features = await fetchCrateFeatures(crateInfo.crateName, crateInfo.version)
            }

            const existingFeatures = getExistingFeatures(lineText)
            const filteredFeatures = features.filter(feature => !existingFeatures.has(feature.name))

            return filteredFeatures.map(feature => {
                const item = new vscode.CompletionItem(feature.name, vscode.CompletionItemKind.Property)

                item.detail = crateInfo.path
                    ? `[Local] ${crateInfo.crateName}`
                    : `[Remote] ${crateInfo.crateName}@${crateInfo.version || "latest"}`

                if (feature.enable.length > 0) {
                    const activationList = feature.enable.join(", ")
                    item.detail = item.detail + ` enable:(${activationList})`
                }

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
): { crateName: string; path?: string; version?: string } | undefined {
    const currentLine = document.lineAt(position.line).text
    const documentDir = path.dirname(document.uri.fsPath)

    // math feature-name = { version = "1.0", path = "../serde", features = ["
    const inlineMatch = currentLine.match(/^\s*([\w-]+)\s*=\s*\{/)
    if (inlineMatch) {
        const crateName = inlineMatch[1]
        const pathMatch = currentLine.match(/path\s*=\s*["']([^"']+)["']/)
        const versionMatch = currentLine.match(/version\s*=\s*["']([^"']+)["']/)

        return {
            crateName,
            path: pathMatch ? path.resolve(documentDir, pathMatch[1]) : undefined,
            version: versionMatch ? versionMatch[1] : undefined,
        }
    }

    // math [dependencies.feature-name]
    for (let i = position.line - 1; i >= 0; i--) {
        const line = document.lineAt(i).text.trim()
        const tableMatch = line.match(/^\[(?:[a-z-]+\.)([\w-]+)\]/)
        if (tableMatch) {
            const crateName = tableMatch[1]
            let foundPath: string | undefined
            let foundVersion: string | undefined

            const max_search_lines = 15
            for (let j = i + 1; j < i + max_search_lines && j < document.lineCount; j++) {
                const nextLine = document.lineAt(j).text.trim()
                if (nextLine.startsWith("[")) break

                const pathMatch = nextLine.match(/^path\s*=\s*["']([^"']+)["']/)
                if (pathMatch) foundPath = path.resolve(documentDir, pathMatch[1])

                const versionMatch = nextLine.match(/^version\s*=\s*["']([^"']+)["']/)
                if (versionMatch) foundVersion = versionMatch[1]
            }
            return { crateName, path: foundPath, version: foundVersion }
        }
        if (line.startsWith("[") && !line.includes("dependencies")) break
    }

    return undefined
}

function fetchLocalCrateFeatures(cratePath: string): FeatureInfo[] {
    try {
        const tomlPath = path.join(cratePath, "Cargo.toml")
        if (!fs.existsSync(tomlPath)) return []

        const content = fs.readFileSync(tomlPath, "utf-8")
        const features: FeatureInfo[] = []
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
                // math feature-name = ["dep1", "dep2"]
                const match = trimmed.match(/^([\w-]+)\s*=\s*\[(.*?)\]/)
                if (match) {
                    const name = match[1]
                    const activates = []
                    for (const s of match[2].split(",")) {
                        let activate = s.trim().replace(/["']/g, "")
                        if (activate !== "") activates.push(activate)
                    }
                    features.push({ name, enable: activates })
                } else {
                    // math feature-name = [] or feature-name = ""
                    const simpleMatch = trimmed.match(/^([\w-]+)\s*=/)
                    if (simpleMatch) features.push({ name: simpleMatch[1], enable: [] })
                }
            }
        }
        return features
    } catch (e) {
        return []
    }
}

type CargoVersionInfo = {
    num: string // version number
    features: { [name: string]: FeatureInfo["enable"] }
}
async function fetchCrateFeatures(crateName: string, version?: string): Promise<FeatureInfo[]> {
    const crateNameVerson = version ? `${crateName}@${version}` : `${crateName}@latest`
    if (featuresCache.has(crateNameVerson)) {
        return featuresCache.get(crateNameVerson)!
    }

    try {
        const response = await fetch(`https://crates.io/api/v1/crates/${crateName}`, {
            headers: { "User-Agent": "cargo-feature-autocomplete" },
            signal: AbortSignal.timeout(5000),
        })

        if (!response.ok) {
            throw new Error(`fetch error: ${response.status}`)
        }

        const data = await response.json()
        const versions = data.versions as CargoVersionInfo[]
        if (!versions || versions.length === 0) return []

        let targetVersion = versions[0] // default latest version
        if (version) {
            const versionNum = version.replace(/[\^~=]/g, "").trim()
            const match = versions.find(v => v.num === versionNum)
            if (match) {
                targetVersion = match
            } else {
                // 0.1.2 -> 0.1
                const partialMatch = versions.find(v => v.num.startsWith(versionNum))
                if (partialMatch) {
                    targetVersion = partialMatch
                }
            }
        }

        const filtered = []
        let features = Object.entries(targetVersion.features || {}).sort(([a], [b]) => a.localeCompare(b))
        for (const [name, enable] of features) {
            if (!name.startsWith("_")) {
                filtered.push({ name, enable })
            }
        }
        featuresCache.set(crateNameVerson, filtered)
        return filtered
    } catch (e) {
        console.error(`Failed to fetch features for ${crateName}`, e)
    }
    return []
}
