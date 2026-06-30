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

    it("can convert legacy content.xml .xmind file to XMindMark content", async () => {
        const legacyContentXML = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:svg="http://www.w3.org/2000/svg">
  <sheet id="sheet-1">
    <topic id="root-topic" structure-class="org.xmind.ui.logic.right">
      <title>Central Topic</title>
      <children>
        <topics type="attached">
          <topic id="main-topic-1" branch="folded">
            <title>Main Topic 1</title>
            <children>
              <topics type="attached">
                <topic id="subtopic-1">
                  <title svg:width="500">Subtopic &amp; Details</title>
                </topic>
              </topics>
            </children>
          </topic>
          <topic id="main-topic-2">
            <title>Main Topic 2</title>
          </topic>
        </topics>
      </children>
    </topic>
    <title>Map 1</title>
  </sheet>
</xmap-content>`
        const legacyFile = await new JSZip()
            .file("content.xml", legacyContentXML)
            .generateAsync({ type: "arraybuffer", compression: "STORE" })

        const output = await parseXMindToXMindMarkFile(legacyFile)

        expect(output).toBe(
            "Central Topic\n- Main Topic 1 [F]\n    - Subtopic & Details\n- Main Topic 2\n"
        )
    })
})
