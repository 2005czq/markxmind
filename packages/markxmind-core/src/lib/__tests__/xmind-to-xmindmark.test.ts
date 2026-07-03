import JSZip from "jszip"
import { beforeEach, describe, expect, it } from "vitest"
import { parseXMindToXMindMarkFile } from "../xmind-to-xmindmark"
import { expectedOutputXMindMark, inputJSON } from "./xmind-to-xmindmark.sample"

let sampleFile: ArrayBuffer

describe("XMindMark: form .xmind file", () => {
    beforeEach(async () => {
        const zip = new JSZip()
        sampleFile = await zip
            .file("content.json", JSON.stringify(inputJSON))
            .generateAsync({ type: "arraybuffer", compression: "STORE" })
    })

    it("can convert .xmind file to XMindMark content", async () => {
        const output = await parseXMindToXMindMarkFile(sampleFile)
        expect(output).toBe(expectedOutputXMindMark)
    })

    it("can convert legacy .xmind files with content.xml", async () => {
        const legacyFile = await new JSZip()
            .file(
                "content.xml",
                `<?xml version="1.0" encoding="UTF-8"?>
                <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
                    <sheet id="sheet-1">
                        <topic id="root" branch="folded">
                            <title>Central &amp; Topic</title>
                            <children>
                                <topics type="attached">
                                    <topic id="child-1">
                                        <title>Child 1</title>
                                    </topic>
                                    <topic id="child-2" branch="folded">
                                        <title>Child 2</title>
                                    </topic>
                                </topics>
                            </children>
                        </topic>
                        <title>Sheet 1</title>
                    </sheet>
                </xmap-content>`
            )
            .generateAsync({ type: "arraybuffer", compression: "STORE" })

        const output = await parseXMindToXMindMarkFile(legacyFile)

        expect(output).toBe("Central & Topic [F]\n- Child 1\n- Child 2 [F]\n")
    })
})
