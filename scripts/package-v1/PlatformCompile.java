import aster.core.identifier.VocabularyLoader;
import aster.core.identifier.VocabularyScopes;
import aster.core.ir.CoreIrJson;
import aster.core.lexicon.SemanticTokenKind;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.aster.policy.parser.InProcessCnlParser;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 包格式 v1 夹具的「平台 IR」采集工具（ADR 0059 P1 T1）：按 aster-api {@code PolicyCompiler} 的生产编译序列取规范 Core IR 字节。
 *
 * <p>序列与 P0 实测（实施计划「P0 结果」§4）相同：aliasSet 空 → {@code InProcessCnlParser.parse(src, locale, scopes)}；
 * 非空 → {@code parseWithUserAliases(src, locale, scopes, aliasSet, allowStructural)}；词汇 →
 * {@code VocabularyScopes.build(VocabularyLoader.loadFromMap(map))}；最后 {@code CoreIrJson.serialize}。
 *
 * <p>只在本地重新采集夹具时使用（{@code node scripts/build-package-fixtures.mjs --capture-platform --cp-file <cp.txt>}），
 * classpath 取本地已构建的 aster-api {@code build/quarkus-app/lib/main/*.jar} 与 app jar。CI 不运行它：采集结果以
 * {@code conformance/package-v1/src/<name>/platform-core.json} 入库，{@code --check} 只依赖入库字节。
 *
 * <p>协议：stdin 每行 {@code {id, source, locale, aliasSet?, vocabulary?, allowStructural?}}；
 * stdout 每行 {@code {id, ok, coreJson | error}}。
 */
public class PlatformCompile {
  @SuppressWarnings("unchecked")
  public static void main(String[] args) throws Exception {
    ObjectMapper m = new ObjectMapper();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    String line;
    while ((line = in.readLine()) != null) {
      if (line.isBlank()) continue;
      Map<String, Object> req = m.readValue(line, Map.class);
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("id", req.get("id"));
      try {
        String src = (String) req.get("source");
        String locale = (String) req.get("locale");
        Map<String, List<String>> rawAlias = (Map<String, List<String>>) req.get("aliasSet");
        Map<SemanticTokenKind, List<String>> aliasSet = new EnumMap<>(SemanticTokenKind.class);
        if (rawAlias != null) {
          for (var e : rawAlias.entrySet()) aliasSet.put(SemanticTokenKind.valueOf(e.getKey()), List.copyOf(e.getValue()));
        }
        Map<String, Object> vocab = (Map<String, Object>) req.get("vocabulary");
        VocabularyScopes scopes = vocab == null || vocab.isEmpty() ? null : VocabularyScopes.build(VocabularyLoader.loadFromMap(vocab));
        boolean allowStructural = Boolean.TRUE.equals(req.get("allowStructural"));
        InProcessCnlParser.ParseResult r = aliasSet.isEmpty()
            ? InProcessCnlParser.parse(src, locale, scopes)
            : InProcessCnlParser.parseWithUserAliases(src, locale, scopes, aliasSet, allowStructural);
        out.put("ok", true);
        out.put("coreJson", CoreIrJson.serialize(r.core()));
      } catch (Throwable t) {
        out.put("ok", false);
        out.put("error", t.getClass().getSimpleName() + ": " + t.getMessage());
      }
      System.out.println(m.writeValueAsString(out));
    }
  }
}
