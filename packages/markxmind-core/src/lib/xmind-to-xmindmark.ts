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

export async function parseXMindToXMindMarkFile(
    xmindFile: ArrayBuffer,
    targetSheetOrder: number = 0
): Promise<XMindMarkContent> {
    const sheets = await tryExtractSheets(xmindFile)

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

async function tryExtractSheets(
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

type XMLElement = {
    name: string
    attributes: Record<string, string>
    children: XMLElement[]
    text: string[]
}

function parseLegacyContentXML(contentXML: string): SheetModel[] {
    const documentNode = parseXMLDocument(contentXML)
    const sheets = findDescendants(documentNode, "sheet")
    let generatedId = 0

    const nextId = () => `legacy-xmind-${generatedId++}`

    return sheets
        .map((sheet, index): SheetModel | null => {
            const rootTopic = childElements(sheet, "topic")[0]
            if (!rootTopic) return null

            return {
                id: sheet.attributes.id ?? nextId(),
                class: "sheet",
                title:
                    textContent(childElements(sheet, "title")[0]) ||
                    `Map ${index + 1}`,
                rootTopic: topicFromLegacyXML(rootTopic, nextId),
                topicPositioning: "fixed",
                relationships: []
            }
        })
        .filter((sheet): sheet is SheetModel => sheet !== null)
}

function topicFromLegacyXML(
    topic: XMLElement,
    nextId: () => string
): TopicModel {
    const model: TopicModel = {
        id: topic.attributes.id ?? nextId(),
        class: "topic",
        title: textContent(childElements(topic, "title")[0]),
        titleUnedited: true
    }
    const structureClass = topic.attributes["structure-class"]
    const { branch } = topic.attributes

    if (structureClass) model.structureClass = structureClass
    if (branch) model.branch = branch

    const children = childElements(topic, "children")[0]
    const attached = children
        ? childElements(children, "topics")
              .filter((topics) => topics.attributes.type === "attached")
              .flatMap((topics) => childElements(topics, "topic"))
              .map((child) => topicFromLegacyXML(child, nextId))
        : []

    if (attached.length > 0) {
        model.children = { attached }
    }

    return model
}

function parseXMLDocument(contentXML: string): XMLElement {
    const documentNode = makeXMLElement("#document", {})
    const stack = [documentNode]
    const tokenRE =
        /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g
    let match: RegExpExecArray | null

    while ((match = tokenRE.exec(contentXML))) {
        const token = match[0]
        const parent = stack[stack.length - 1]

        if (token.startsWith("<!--") || token.startsWith("<?")) continue
        if (token.startsWith("<![CDATA[")) {
            parent.text.push(token.slice(9, -3))
            continue
        }
        if (token.startsWith("</")) {
            stack.pop()
            continue
        }
        if (token.startsWith("<!")) continue
        if (token.startsWith("<")) {
            const selfClosing = token.endsWith("/>")
            const content = token.slice(1, selfClosing ? -2 : -1).trim()
            const firstSpace = content.search(/\s/)
            const name =
                firstSpace === -1 ? content : content.slice(0, firstSpace)
            const attributes =
                firstSpace === -1
                    ? {}
                    : parseXMLAttributes(content.slice(firstSpace + 1))
            const element = makeXMLElement(name, attributes)

            parent.children.push(element)
            if (!selfClosing) stack.push(element)
            continue
        }

        parent.text.push(decodeXMLText(token))
    }

    return documentNode
}

function makeXMLElement(
    name: string,
    attributes: Record<string, string>
): XMLElement {
    return {
        name,
        attributes,
        children: [],
        text: []
    }
}

function parseXMLAttributes(source: string): Record<string, string> {
    const attributes: Record<string, string> = {}
    const attrRE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let match: RegExpExecArray | null

    while ((match = attrRE.exec(source))) {
        attributes[match[1]] = decodeXMLText(match[2] ?? match[3] ?? "")
    }

    return attributes
}

function childElements(element: XMLElement, name: string): XMLElement[] {
    return element.children.filter((child) => localName(child.name) === name)
}

function findDescendants(element: XMLElement, name: string): XMLElement[] {
    const matches = localName(element.name) === name ? [element] : []

    return element.children.reduce<XMLElement[]>(
        (result, child) => result.concat(findDescendants(child, name)),
        matches
    )
}

function textContent(element?: XMLElement): string {
    if (!element) return ""

    return element.text
        .concat(element.children.map((child) => textContent(child)))
        .join("")
        .replace(/\s+/g, " ")
        .trim()
}

function localName(name: string): string {
    const index = name.indexOf(":")
    return index === -1 ? name : name.slice(index + 1)
}

function decodeXMLText(text: string): string {
    return text.replace(
        /&(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
        (_entity, value: string) => {
            if (value === "amp") return "&"
            if (value === "lt") return "<"
            if (value === "gt") return ">"
            if (value === "quot") return '"'
            if (value === "apos") return "'"
            if (value.startsWith("#x")) {
                return String.fromCodePoint(parseInt(value.slice(2), 16))
            }
            return String.fromCodePoint(parseInt(value.slice(1), 10))
        }
    )
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
