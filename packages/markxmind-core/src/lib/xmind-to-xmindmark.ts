import JSZip from "jszip"
import {
    type BoundaryModel,
    type RelationshipModel,
    type SheetModel,
    type SummaryModel,
    type TopicModel,
    type TopicType
} from "../types"

export type XMindMarkContent = string

type Identifier = { readonly identifier: string }
type Boundary = BoundaryModel & Identifier
type Summary = SummaryModel &
    Identifier & {
        title: string
    }
type Relationship = RelationshipModel & Identifier
type SheetScope = {
    readonly relationships: Relationship[]
}
type BranchScope = SheetScope & {
    readonly depth: number
    readonly boundaries: Boundary[]
    readonly summaries: Summary[]
}
type TopicScope = BranchScope & {
    readonly id: string
    readonly labels: string[]
    readonly title: string
    readonly order: number // starts from 0, like index
    readonly type: TopicType | "root"
    readonly href?: string
    readonly notes?: any
    readonly branch?: string
}
type TopicScopeObserver = (scope: TopicScope) => void
type BranchScopeObserver = (scope: BranchScope) => void
type ClosedRange = `(${number},${number})`
type LegacyXMLTag = {
    readonly name: string
    readonly attributes: Record<string, string>
    readonly isClosing: boolean
    readonly isSelfClosing: boolean
}
type LegacySheetModel = Omit<SheetModel, "rootTopic"> & {
    rootTopic?: TopicModel
}

export async function parseXMindToXMindMarkFile(
    xmindFile: ArrayBuffer,
    targetSheetOrder: number = 0
): Promise<XMindMarkContent> {
    const sheets = await tryExtractXMindContent(xmindFile)

    return sheets && sheets[targetSheetOrder]
        ? xmindMarkFrom(sheets[targetSheetOrder])
        : ""
}

function xmindMarkFrom({
    rootTopic,
    relationships
}: SheetModel): XMindMarkContent {
    const lines: string[] = []

    const topicScopeObserver: TopicScopeObserver = (scope) => {
        const indent = makeIndentOfLine(scope)
        const prefix = makePrefixOfLine(scope)
        const typeIdentifier = makeTypeIdentifierOfLine(scope)
        const title = makeTitleOfLine(scope)
        const extensionIdentifier = makeExtensionIdentifierOfLine(scope)

        const line = indent.concat(
            ...[
                prefix,
                typeIdentifier.length > 0 ? `${typeIdentifier} ` : "",
                // label.length > 0 ? `${label} ` : '',
                title,
                extensionIdentifier
            ]
        )

        lines.push(line)
    }

    const branchScopeObserver: BranchScopeObserver = (scope) => {
        scope.boundaries.forEach((boundary) => {
            if (boundary.title) {
                lines.push(makeBoundaryTitleLine(scope, boundary))
            }
        })
    }

    traverseBranch(
        rootTopic,
        topicScopeObserver,
        branchScopeObserver,
        relationships
    )
    lines.push("") // append last empty line
    return lines.join("\n")
}

function traverseBranch(
    rootTopic: TopicModel,
    onTopicScope: TopicScopeObserver,
    onBranchScope: BranchScopeObserver,
    relationships: RelationshipModel[] = [],
    index?: number,
    prevBranchScope?: BranchScope,
    type?: TopicType
) {
    const branchScope: BranchScope = {
        depth: prevBranchScope?.depth ?? 0,
        boundaries:
            prevBranchScope?.boundaries ?? makeIdentifyBoundaries(rootTopic),
        summaries:
            prevBranchScope?.summaries ?? makeIdentifySummaries(rootTopic),
        relationships:
            prevBranchScope?.relationships ??
            makeIdentifyRelationships(relationships)
    }

    const topicScope: TopicScope = {
        id: rootTopic.id,
        labels: rootTopic.labels ?? [],
        title: rootTopic.title ?? "",
        order: index ?? 0,
        type: type ?? "root",
        href: rootTopic.href,
        notes: rootTopic.notes,
        branch: rootTopic.branch,
        ...branchScope
    }

    onTopicScope(topicScope)

    const currentBranchScope: BranchScope = {
        depth: branchScope.depth + 1,
        boundaries: makeIdentifyBoundaries(rootTopic),
        summaries: makeIdentifySummaries(rootTopic),
        relationships: branchScope.relationships
    }

    rootTopic.children?.attached?.forEach((child, i) =>
        traverseBranch(
            child,
            onTopicScope,
            onBranchScope,
            relationships,
            i,
            currentBranchScope,
            "attached"
        )
    )
    rootTopic.children?.summary?.forEach((child, i) =>
        traverseBranch(
            child,
            onTopicScope,
            onBranchScope,
            relationships,
            i,
            currentBranchScope,
            "summary"
        )
    )

    onBranchScope(currentBranchScope)
}

///////////////////////////////////////////
//
// File loader
//

async function tryExtractXMindContent(
    file: ArrayBuffer
): Promise<SheetModel[] | null> {
    try {
        const zip = await new JSZip().loadAsync(file)
        const contentJSON = await zip.file("content.json")?.async("string")
        if (contentJSON) return JSON.parse(contentJSON) as SheetModel[]

        const contentXML = await zip.file("content.xml")?.async("string")
        return contentXML ? parseLegacyContentXML(contentXML) : null
    } catch (e) {
        console.error("Not valid .xmind file.")
        return null
    }
}

function parseLegacyContentXML(xml: string): SheetModel[] {
    const sheets: LegacySheetModel[] = []
    const topicStack: TopicModel[] = []
    const topicsTypeStack: TopicType[] = []
    let currentSheet: LegacySheetModel | undefined
    let titleTarget: TopicModel | LegacySheetModel | undefined
    let titleBuffer = ""

    for (const token of xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) ??
        []) {
        if (token.startsWith("<![CDATA[")) {
            if (titleTarget) titleBuffer += token.slice(9, -3)
            continue
        }

        if (!token.startsWith("<")) {
            if (titleTarget) titleBuffer += decodeXMLText(token)
            continue
        }

        if (token.startsWith("<?") || token.startsWith("<!--")) continue

        const tag = parseLegacyXMLTag(token)
        if (!tag) continue

        if (tag.isClosing) {
            if (tag.name === "topic") {
                topicStack.pop()
            } else if (tag.name === "topics") {
                topicsTypeStack.pop()
            } else if (tag.name === "title" && titleTarget) {
                titleTarget.title = titleBuffer.trim()
                titleTarget = undefined
                titleBuffer = ""
            } else if (tag.name === "sheet") {
                currentSheet = undefined
            }
            continue
        }

        if (tag.name === "sheet") {
            currentSheet = {
                id: tag.attributes.id ?? "",
                class: "sheet",
                title: "",
                topicPositioning: "",
                relationships: []
            }
            sheets.push(currentSheet)
        } else if (tag.name === "topics") {
            topicsTypeStack.push(toTopicType(tag.attributes.type))
        } else if (tag.name === "topic" && currentSheet) {
            const topic = createLegacyTopic(tag.attributes)
            const parentTopic = topicStack[topicStack.length - 1]
            const topicType = topicsTypeStack[topicsTypeStack.length - 1]

            if (parentTopic) {
                parentTopic.children ??= {}
                parentTopic.children[topicType] ??= []
                parentTopic.children[topicType]?.push(topic)
            } else {
                currentSheet.rootTopic = topic
            }

            if (!tag.isSelfClosing) topicStack.push(topic)
        } else if (tag.name === "title") {
            titleTarget = topicStack[topicStack.length - 1] ?? currentSheet
            titleBuffer = ""
        }

        if (tag.isSelfClosing && tag.name === "topics") topicsTypeStack.pop()
    }

    return sheets.filter((sheet): sheet is SheetModel =>
        Boolean(sheet.rootTopic)
    )
}

function parseLegacyXMLTag(token: string): LegacyXMLTag | null {
    const isClosing = token.startsWith("</")
    const isSelfClosing = token.endsWith("/>")
    const content = token
        .slice(isClosing ? 2 : 1, isSelfClosing ? -2 : -1)
        .trim()
    const name = content
        .match(/^([^\s/>]+)/)?.[1]
        ?.split(":")
        .pop()
    if (!name) return null

    return {
        name,
        attributes: parseLegacyXMLAttributes(content),
        isClosing,
        isSelfClosing
    }
}

function parseLegacyXMLAttributes(content: string): Record<string, string> {
    const attributes: Record<string, string> = {}
    const attributePattern = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let match: RegExpExecArray | null

    while ((match = attributePattern.exec(content))) {
        attributes[match[1]] = decodeXMLText(match[2] ?? match[3] ?? "")
    }

    return attributes
}

function decodeXMLText(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
}

function createLegacyTopic(attributes: Record<string, string>): TopicModel {
    return {
        id: attributes.id ?? "",
        title: "",
        branch: attributes.branch,
        structureClass: attributes["structure-class"],
        href: attributes["xlink:href"] ?? attributes.href
    }
}

function toTopicType(type?: string): TopicType {
    return type === "detached" || type === "summary" ? type : "attached"
}

///////////////////////////////////////////
//
// Converters
//

function isOrderInsideRange(range: ClosedRange, order: number): boolean {
    const [start, end] = range
        .replace(/[(|)]/g, "")
        .split(",")
        .map((s) => parseInt(s.trim()))

    return start <= end && start <= order && order <= end
}

function makeIndentOfLine({ depth }: Pick<TopicScope, "depth">): string {
    return depth <= 1
        ? ""
        : Array.from({ length: depth - 1 }).reduce<string>(
              (prevIndent) => prevIndent.concat("    "),
              ""
          )
}

function makePrefixOfLine({ depth, type }: TopicScope): string {
    if (type === "attached") return depth > 0 ? "- " : ""

    return ""
}

function makeTypeIdentifierOfLine({ type, id, summaries }: TopicScope): string {
    if (type === "summary") {
        const summary = summaries.find((summary) => summary.topicId === id)
        return summary ? `[${summary.identifier}]` : ""
    }

    return ""
}

function makeTitleOfLine({ title }: TopicScope): string {
    return title
}

function makeURLIdentifierOfLine({ href }: TopicScope): string {
    return href ? `[L:${href}]` : ""
}

function makeNoteIdentifierOfLine({ notes }: TopicScope): string {
    if (!notes || !notes.plain) return ""
    if (notes.plain.content) {
        const escapedContent = notes.plain.content
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t")
            .replace(/\[/g, "\\[")
            .replace(/\]/g, "\\]")
            .trim()

        return `[N:${escapedContent}]`
    }
    return ""
}

function makeFoldIdentifierOfLine({ branch }: TopicScope): string {
    return branch === "folded" ? `[F]` : ""
}

function makeRelationshipIdentifierOfLine({
    relationships,
    id
}: TopicScope): string {
    const relationshipBegin = relationships.find(({ end1Id }) => end1Id === id)
    const relationshipEnd = relationships.find(({ end2Id }) => end2Id === id)

    if (relationshipBegin) return `[^${relationshipBegin.identifier}]`
    if (relationshipEnd) return `[${relationshipEnd.identifier}]`
    return ""
}

function makeBoundaryIdenfitierOfLine(scope: TopicScope): string {
    const { boundaries, type } = scope
    if (type !== "attached" || !boundaries || boundaries.length === 0) return ""

    if (boundaries.length === 1)
        return isOrderInsideRange(boundaries[0].range, scope.order)
            ? `[${boundaries[0].identifier}]`
            : ""
    else
        return boundaries.reduce(
            (str, { range, identifier }) =>
                isOrderInsideRange(range, scope.order)
                    ? `${str}[${identifier}]`
                    : str,
            ""
        )
}

function makeSummaryIdentifierOfLine(scope: TopicScope): string {
    const { summaries, type } = scope
    if (
        type === "root" ||
        type === "summary" ||
        !summaries ||
        summaries.length === 0
    )
        return ""

    if (summaries.length === 1)
        return isOrderInsideRange(summaries[0].range, scope.order)
            ? `[${summaries[0].identifier}]`
            : ""
    else
        return summaries.reduce(
            (str, { range, identifier }) =>
                isOrderInsideRange(range, scope.order)
                    ? `${str}[${identifier}]`
                    : str,
            ""
        )
}

function makeExtensionIdentifierOfLine(scope: TopicScope): string {
    const relationshipIdentifier = makeRelationshipIdentifierOfLine(scope)
    const boundaryIdentifier = makeBoundaryIdenfitierOfLine(scope)
    const summaryIdentifier = makeSummaryIdentifierOfLine(scope)
    const urlIdentifier = makeURLIdentifierOfLine(scope)
    const noteIdentifier = makeNoteIdentifierOfLine(scope)
    const foldIdentifier = makeFoldIdentifierOfLine(scope)

    const identifiers = [
        relationshipIdentifier,
        boundaryIdentifier,
        summaryIdentifier,
        urlIdentifier,
        noteIdentifier,
        foldIdentifier
    ].filter((id) => id !== "")

    return identifiers.length > 0 ? ` ${identifiers.join("")}` : ""
}

function makeBoundaryTitleLine(
    scope: BranchScope,
    { identifier, title }: Boundary
): string {
    return `${makeIndentOfLine(scope)}[${identifier}] ${title}`
}

function makeIdentifyBoundaries(topic: TopicModel): Boundary[] {
    if (!topic.boundaries || topic.boundaries.length === 0) return []

    if (topic.boundaries.length === 1)
        return [{ ...topic.boundaries[0], identifier: "B" }]

    return topic.boundaries.map((boundary, i) => ({
        ...boundary,
        identifier: `B${i + 1}`
    }))
}

function makeIdentifySummaries(topic: TopicModel): Summary[] {
    if (
        topic.summaries &&
        topic.summaries.length > 0 &&
        topic.children &&
        Array.isArray(topic.children?.summary) &&
        topic.children.summary.length > 0 &&
        topic.children.summary.length === topic.summaries.length
    ) {
        const summaries = topic.summaries
            .map((summary, i) => {
                const title = topic.children!.summary?.find(
                    ({ id }) => id === summary.topicId
                )?.title

                return typeof title !== "undefined"
                    ? { ...summary, title, identifier: `S${i + 1}` }
                    : null
            })
            .filter((summary): summary is Summary => !!summary)

        if (summaries.length === 1)
            return summaries.map((summary) => ({
                ...summary,
                identifier: "S"
            }))

        return summaries
    }

    return []
}

function makeIdentifyRelationships(
    relationships: RelationshipModel[]
): Relationship[] {
    return relationships.map((relationship, i) => ({
        ...relationship,
        identifier: `${i + 1}`
    }))
}
