import osPath from 'path';
import url from 'url';
import { getAttribute, predicates, query, queryAll, remove, removeFakeRootElements } from 'dom5';
import { getOptions, stringifyRequest } from 'loader-utils';
import espree from 'espree';
import { minify } from 'html-minifier';
import { normalizeCondition } from 'webpack/lib/RuleSet';
import parse5 from 'parse5';
import sourceMap from 'source-map';

const domPred = predicates.AND(predicates.hasTagName('dom-module'));
const linkPred = predicates.AND(predicates.hasTagName('link'));
const scriptsPred = predicates.AND(predicates.hasTagName('script'));

class ProcessHtml {
  constructor(content, loader) {
    this.content = content;
    this.options = getOptions(loader) || {};
    this.currentFilePath = loader.resourcePath;
  }
  /**
   * Process `<link>` tags, `<dom-module>` elements, and any `<script>`'s.
   * Return transformed content as a bundle for webpack.
   */
  process() {
    const links = this.links();
    const doms = this.domModule();
    return this.scripts(links.source + doms.source, links.lineCount + doms.lineCount);
  }
  /**
   * Look for all `<link>` elements and turn them into `import` statements.
   * e.g.
   * ```
   * <link rel="import" href="paper-input/paper-input.html">
   * ```
   * becomes:
   * ```
   * import '/absolute/path/to/paper-input/paper-input.html';
   * ```
   * @return {{source: string, lineCount: number}}
   */
  links() {
    const doc = parse5.parse(this.content, { locationInfo: true });
    removeFakeRootElements(doc);
    const links = queryAll(doc, linkPred);

    let source = '';

    // A function to test an href against options.ignoreLinks and options.ignoreLinksFromPartialMatches
    let shouldIgnore;
    let ignoreConditions = [];
    if (this.options.ignoreLinks) {
      ignoreConditions = ignoreConditions.concat(this.options.ignoreLinks);
    }
    if (this.options.ignoreLinksFromPartialMatches) {
      const partials = this.options.ignoreLinksFromPartialMatches;
      ignoreConditions = ignoreConditions.concat(resource =>
        partials.some(partial => resource.indexOf(partial) > -1));
    }

    if (ignoreConditions.length > 0) {
      shouldIgnore = normalizeCondition(ignoreConditions);
    } else {
      shouldIgnore = () => false;
    }

    // A function to test an href against options.ignorePathReWrite
    let shouldRewrite;
    if (this.options.ignorePathReWrite) {
      shouldRewrite = normalizeCondition({ not: this.options.ignorePathReWrite });
    } else {
      shouldRewrite = () => true;
    }

    let lineCount = 0;
    links.forEach((linkNode) => {
      const href = getAttribute(linkNode, 'href');
      if (!href || shouldIgnore(href)) {
        return;
      }

      let path;
      if (shouldRewrite(href)) {
        path = osPath.join(osPath.dirname(this.currentFilePath), href);
      } else {
        path = href;
      }

      source += `\nimport ${stringifyRequest(this, path)};\n`;
      lineCount += 2;
    });
    return {
      source,
      lineCount,
    };
  }
  /**
   * Looks for all `<dom-module>` elements, removing any `<script>`'s without a
   * `src` and any `<link>` tags, as these are processed in separate steps.
   * @return {{source: string, lineCount: number}}
   */
  domModule() {
    const doc = parse5.parse(this.content, { locationInfo: true });
    removeFakeRootElements(doc);
    const domModule = query(doc, domPred);
    const scripts = queryAll(doc, scriptsPred);
    scripts.forEach((scriptNode) => {
      const src = getAttribute(scriptNode, 'src') || '';
      if (src) {
        const parseSrc = url.parse(src);
        if (!parseSrc.protocol || !parseSrc.slashes) {
          remove(scriptNode);
        }
      } else {
        remove(scriptNode);
      }
    });
    const links = queryAll(doc, linkPred);
    links.forEach((linkNode) => {
      remove(linkNode);
    });
    const html = domModule ? domModule.parentNode : doc;
    const minimized = minify(parse5.serialize(html), {
      collapseWhitespace: true,
      conservativeCollapse: true,
      minifyCSS: true,
      removeComments: true,
    });
    if (minimized) {
      if (domModule) {
        return {
          source: `
const RegisterHtmlTemplate = require('polymer-webpack-loader/register-html-template');
RegisterHtmlTemplate.register(${JSON.stringify(minimized)});
`,
          lineCount: 3,
        };
      }
      return {
        source: `
const RegisterHtmlTemplate = require('polymer-webpack-loader/register-html-template');
RegisterHtmlTemplate.toBody(${JSON.stringify(minimized)});
`,
        lineCount: 3,
      };
    }
    return {
      source: '',
      lineCount: 0,
    };
  }
  /**
   * Look for all `<script>` elements. If the script has a valid `src` attribute
   * it will be converted to an `import` statement.
   * e.g.
   * ```
   * <script src="foo.js">
   * becomes:
   * import 'foo';
   * ```
   * Otherwise if it's an inline script block, the content will be serialized
   * and returned as part of the bundle.
   * @param {string} initialSource previously generated JS
   * @param {number} initialLineOffset number of lines already in initialSource
   * @return {{source: string, sourceMap: Object=}}
   */
  scripts(initialSource, initialLineOffset) {
    let lineOffset = initialLineOffset;
    const doc = parse5.parse(this.content, { locationInfo: true });
    removeFakeRootElements(doc);
    const scripts = queryAll(doc, scriptsPred);
    let source = initialSource;
    let sourceMapGenerator = null;
    scripts.forEach((scriptNode) => {
      const src = getAttribute(scriptNode, 'src') || '';
      if (src) {
        const parseSrc = url.parse(src);
        if (!parseSrc.protocol || !parseSrc.slashes) {
          const path = osPath.join(osPath.dirname(this.currentFilePath), src);
          source += `\nimport ${stringifyRequest(this, path)};\n`;
          lineOffset += 2;
        }
      } else {
        const scriptContents = parse5.serialize(scriptNode);
        sourceMapGenerator = sourceMapGenerator || new sourceMap.SourceMapGenerator();
        const tokens = espree.tokenize(scriptContents, {
          loc: true,
          ecmaVersion: 2017,
          sourceType: 'module',
        });

        // For script node content tokens, we need to offset the token position by the
        // line number of the script tag itself. And for the first line, offset the start
        // column to account for the <script> tag itself.
        const currentScriptLineOffset = scriptNode.childNodes[0].__location.line - 1; // eslint-disable-line no-underscore-dangle
        const firstLineCharOffset = scriptNode.childNodes[0].__location.col; // eslint-disable-line no-underscore-dangle
        tokens.forEach((token) => {
          if (!token.loc) {
            return;
          }
          const mapping = {
            original: {
              line: token.loc.start.line + currentScriptLineOffset,
              column: token.loc.start.column + (token.loc.start.line === 1 ? firstLineCharOffset : 0),
            },
            generated: {
              line: token.loc.start.line + lineOffset,
              column: token.loc.start.column,
            },
            source: this.currentFilePath,
          };

          if (token.type === 'Identifier') {
            mapping.name = token.value;
          }

          sourceMapGenerator.addMapping(mapping);
        });
        source += `\n${scriptContents}\n`;
        // eslint-disable-next-line no-underscore-dangle
        lineOffset += 2 + (scriptNode.__location.endTag.line - scriptNode.__location.startTag.line);
      }
    });
    const retVal = {
      source,
    };
    if (sourceMapGenerator) {
      sourceMapGenerator.setSourceContent(this.currentFilePath, this.content);
      retVal.sourceMap = sourceMapGenerator.toJSON();
    }
    return retVal;
  }
}

// eslint-disable-next-line no-unused-vars
export default function entry(content, map) {
  const results = new ProcessHtml(content, this).process();
  this.callback(null, results.source, results.sourceMap);
}
