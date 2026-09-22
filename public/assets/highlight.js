/* highlight.js — 极简语法高亮（无依赖，~150 行）
   思路：按语言把注释/字符串/数字/关键字/函数调用拼成一个总正则，
   逐段转义输出，因此不存在把 HTML 拼坏或注入的风险。 */
(function () {
  'use strict';

  var KW = {
    js: 'const let var function return if else for while do switch case break continue new class extends super this async await import export from default try catch finally throw typeof instanceof in of delete void yield static get set null undefined true false',
    ts: 'const let var function return if else for while do switch case break continue new class extends super this async await import export from default try catch finally throw typeof instanceof in of delete void yield static get set null undefined true false interface type enum implements declare readonly public private protected as satisfies',
    py: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del in is not and or None True False async await self print',
    go: 'package import func return if else for range break continue var const type struct interface map chan go defer select switch case default nil true false make new len cap append string int int64 float64 bool error byte rune',
    rust: 'fn let mut const return if else for while loop match break continue struct enum impl trait pub use mod crate self super as where dyn async await move ref in true false Some None Ok Err String Vec Option Result',
    java: 'public private protected class interface extends implements return if else for while do switch case break continue new static final void int long double float boolean char String package import try catch finally throw throws this super null true false abstract synchronized volatile',
    sh: 'if then else elif fi for while do done case esac function return in export local readonly echo cd ls mkdir rm cp mv cat grep sed awk curl wget sudo apt systemctl set unset source exit',
    sql: 'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX DROP ALTER JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL PRIMARY KEY FOREIGN REFERENCES DEFAULT UNIQUE DISTINCT COUNT SUM AVG MIN MAX',
    css: 'important media supports keyframes import font-face from to and not only',
    json: 'true false null',
    c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false size_t ssize_t bool uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t',
    cpp: 'auto break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while bool size_t string vector map',
    cs: 'abstract as base bool break byte case catch char class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach get goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed set short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await',
    php: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null',
    ruby: 'alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require attr_accessor puts',
    lua: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while print pairs ipairs require',
    dockerfile: 'FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS',
    nginx: 'server location listen server_name root index try_files proxy_pass proxy_set_header return rewrite if set upstream error_log access_log ssl_certificate ssl_certificate_key include add_header allow deny',
    docker: 'FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG AS',
  };
  var KW_CI = { sql: 1, css: 1 };

  var SPEC = {
    js: { kw: KW.js, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    javascript: { kw: KW.js, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    mjs: { kw: KW.js, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    cjs: { kw: KW.js, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    ts: { kw: KW.ts, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    typescript: { kw: KW.ts, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    py: { kw: KW.py, com: '#[^\\n]*' },
    python: { kw: KW.py, com: '#[^\\n]*' },
    go: { kw: KW.go, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    rust: { kw: KW.rust, com: '\\/\\/[^\\n]*' },
    java: { kw: KW.java, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    kotlin: { kw: KW.java, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    sh: { kw: KW.sh, com: '#[^\\n]*' },
    bash: { kw: KW.sh, com: '#[^\\n]*' },
    shell: { kw: KW.sh, com: '#[^\\n]*' },
    zsh: { kw: KW.sh, com: '#[^\\n]*' },
    sql: { kw: KW.sql, com: '--[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', ci: 1 },
    css: { kw: KW.css, com: '\\/\\*[\\s\\S]*?\\*\\/', ci: 1 },
    json: { kw: KW.json, com: '' },
    c: { kw: KW.c, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    h: { kw: KW.c, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    cpp: { kw: KW.cpp, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    'c++': { kw: KW.cpp, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    cc: { kw: KW.cpp, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    cs: { kw: KW.cs, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    csharp: { kw: KW.cs, com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    php: { kw: KW.php, com: '\\/\\/[^\\n]*|#[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' },
    ruby: { kw: KW.ruby, com: '#[^\\n]*' },
    rb: { kw: KW.ruby, com: '#[^\\n]*' },
    lua: { kw: KW.lua, com: '--[^\\n]*' },
    dockerfile: { kw: KW.dockerfile, com: '#[^\\n]*' },
    docker: { kw: KW.docker, com: '#[^\\n]*' },
    nginx: { kw: KW.nginx, com: '#[^\\n]*' },
    conf: { kw: KW.nginx, com: '#[^\\n]*' },
    yaml: { kw: 'true false null yes no on off', com: '#[^\\n]*' },
    yml: { kw: 'true false null yes no on off', com: '#[^\\n]*' },
    toml: { kw: 'true false', com: '#[^\\n]*' },
    ini: { kw: '', com: '[;#][^\\n]*' },
    html: { kw: '', com: '<!--[\\s\\S]*?-->', html: 1 },
    xml: { kw: '', com: '<!--[\\s\\S]*?-->', html: 1 },
    markdown: { kw: '', com: '' },
    text: null, plain: null, plaintext: null, '': null,
  };

  function esc(s) {
    return s.replace(/[&<>]/g, function (c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; });
  }

  function buildRe(spec) {
    var parts = [], classes = [];
    var add = function (pattern, cls) { if (pattern) { parts.push('(' + pattern + ')'); classes.push(cls); } };
    add(spec.com || '', 'tok-com');
    if (spec.html) {
      add('"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'', 'tok-str');
      add('</?[A-Za-z][\\w:.-]*', 'tok-key');
      add('&[a-zA-Z#\\d]+;', 'tok-op');
      add('\\b\\d+\\b', 'tok-num');
    } else {
      add('"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`', 'tok-str');
      if (spec.kw) add('\\b(?:' + spec.kw.trim().split(/\s+/).join('|') + ')\\b', 'tok-key');
      add('\\b\\d[\\w.]*\\b', 'tok-num');
      add('[A-Za-z_$][\\w$]*(?=\\s*\\()', 'tok-fn');
    }
    return { re: new RegExp(parts.join('|'), 'g' + (spec.ci ? 'i' : '')), classes: classes };
  }

  function apply(codeEl, lang) {
    lang = String(lang || '').toLowerCase();
    var spec = SPEC[lang];
    if (spec === undefined) spec = { kw: '', com: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' };
    if (!spec) return;
    var code = codeEl.textContent;
    if (code.length > 200000) return;
    var built = buildRe(spec);
    var re = built.re, classes = built.classes;
    var out = '', last = 0, m, guard = 0;
    while ((m = re.exec(code)) !== null && guard++ < 20000) {
      if (m[0] === '') { re.lastIndex++; continue; }
      out += esc(code.slice(last, m.index));
      var cls = '';
      for (var g = 0; g < classes.length; g++) {
        if (m[g + 1] !== undefined && m[g + 1] !== '') { cls = classes[g]; break; }
      }
      out += '<span class="' + (cls || 'tok-op') + '">' + esc(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    out += esc(code.slice(last));
    codeEl.innerHTML = out;
  }

  window.BlogHighlight = { apply: apply };
})();
