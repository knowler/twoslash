// @ts-check

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs"
import remark from "remark"
import toHAST from "mdast-util-to-hast"
import hastToHTML from "hast-util-to-html"
import visit from "unist-util-visit"
import { join, dirname } from "path"
import remarkShikiTwoslash from "remark-shiki-twoslash"
import { basename, extname, sep } from "path"
import { tmpdir } from "os"

export const canConvert = (path) => {
  const usable = [".md", ".ts", ".js", ".tsx", ".jsx"]
  if (!usable.includes(extname(path))) return false

  const filename = basename(path)
  if (filename.startsWith(".")) return false

  const stat = statSync(path)
  if (stat.isDirectory()) return false

  return true
}

/** @typedef {{ from: string, to: string, splitOutCodeSamples: boolean, alsoRenderSource: boolean, lint: boolean, realFrom?: string }} Args */
/** @param {Args} args */

export const runOnFile = async args => {
  const { from } = args
  if (!canConvert(from)) return

  switch (extname(from)) {
    case ".md":
      return renderMarkdown(args)
    default:
      return renderJS(args)
  }
}

/** @param {Args} args */
function renderJS(args) {
  // Basically write to a tmp file as a markdown file and go through that pipeline
  const { from } = args

  let fileContent = readFileSync(from, "utf8")

  // Support forwarding the Twoslash Config from the ts to the md
  let prefix = ""
  if (fileContent.startsWith("// twoslash: {")) {
    const js = fileContent.split("\n")[0].replace("// twoslash: ", "")
    prefix = `<!-- twoslash: ${js} -->`
    fileContent = fileContent.replace(`// twoslash: ${js}\n`, "")
  }

  // Support forwarding codefence info for highlighting
  const classes = []
  if (fileContent.startsWith("// codefence: ")) {
    const highlightOpts = fileContent.split("\n")[0].replace("// codefence: ", "")
    classes.push(highlightOpts)
    fileContent = fileContent.replace(`// twoslash: ${highlightOpts}\n`, "")
  }

  const newFileName = tmpdir() + sep + basename(from) + ".md"
  const code = toCode(prefix, extname(from).replace(".", ""), [...classes, "twoslash"], fileContent) 
  writeFileSync(newFileName, code)

  renderMarkdown({ ...args, from: newFileName, realFrom: from,  })

  // Also allow for showing a before/after by supporting a flag which renders the src
  if (args.alsoRenderSource) {
    const newFileName = tmpdir() + sep + basename(from) + "_src.md"
    const code = toCode(prefix, extname(from).replace(".", ""), classes, fileContent) 
    writeFileSync(newFileName, code)
    renderMarkdown({ ...args, from: newFileName, realFrom: from,  })
  }
}

/** @param {Args} args */
async function renderMarkdown(args) {
  const { from, to, splitOutCodeSamples, realFrom } = args

  const fileContent = readFileSync(from, "utf8")
  const settings = getSettingsFromMarkdown(fileContent, from) || {}
  const markdownAST = remark().parse(fileContent)

  // @ts-ignore
  await remarkShikiTwoslash.default(settings)(markdownAST)

  // Bail before writing the new versions if we're linting
  if (args.lint) return

  // Render directly to one file
  if (!splitOutCodeSamples) {
    // The dangerous bit is that we include the HTML
    const hAST = toHAST(markdownAST, { allowDangerousHtml: true })
    const html = hastToHTML(hAST, { allowDangerousHtml: true })

    // Assume folder unless you write .html
    const lastIsHTML = to.endsWith(".html")
    if (!existsSync(to)) {
      const hostFolder = lastIsHTML ? dirname(to) : to
      mkdirSync(hostFolder, { recursive: true })
    }
    
    // Write it
    const writePath = lastIsHTML ? to : join(to, basename(from).replace(".md", ".html"))
    writeFileSync(writePath, html)

    // Log it
    console.log(`  - ${realFrom || from} -> ${writePath} `)
  } else {
    if (!existsSync(to)) mkdirSync(to, { recursive: true })
    if (!existsSync(join(to, "mds"))) mkdirSync(join(to, "mds"))

    let index = 1
    visit(markdownAST, "html", c => {
      const hAST = toHAST(c, { allowDangerousHtml: true })
      const html = hastToHTML(hAST, { allowDangerousHtml: true })
      writeFileSync(join(to, "mds", `code-${index}.html`), html)
      index++
    })

    console.log(` -> Wrote ${index} files to ${to}`)
  }
}

function getSettingsFromMarkdown(fileContent, from) {
  if (fileContent.startsWith("<!-- twoslash: {")) {
    const code = fileContent.split("<!-- twoslash: ")[1].split(" -->")[0]
    try {
      return eval("const res = " + code + "; res")
    } catch (error) {
      console.error(
        `Twoslash CLI: Setting custom theme settings in ${from} failed. The eval'd code is '${code}' which bailed:`
      )
      throw error
    }
  }
}

const toCode = (prefix, lang, classes, content)  => `${prefix}
\`\`\`${lang} ${classes.join(" ")}
${content}
\`\`\`
`