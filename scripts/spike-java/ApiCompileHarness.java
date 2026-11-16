import aster.core.identifier.VocabularyLoader;
import aster.core.identifier.VocabularyScopes;
import aster.core.ir.CoreIrJson;
import aster.core.lexicon.LexiconRegistry;
import aster.core.lexicon.SemanticTokenKind;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.aster.policy.parser.InProcessCnlParser;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;

/**
 * ADR 0059 P0-T0.4 spike（不合并）：按 aster-api PolicyCompiler 的生产编译序列取规范 IR。
 * aliasSet 空 → InProcessCnlParser.parse(src, locale, scopes)；非空 → parseWithUserAliases(..., allowStructural)；
 * 词汇 → VocabularyScopes.build(VocabularyLoader.loadFromMap(map))（同 PolicyVersion.scopesOf）。
 * stdin 每行 {id, source, locale, aliasSet?, vocabulary?, allowStructural?}；stdout 每行 {id, ok, sha256, coreJson | error}。
 * 参数 --base-aliases 时打印各 locale 的 base 别名后退出。
 */
public class ApiCompileHarness {
  public static void main(String[] args) throws Exception {
    ObjectMapper m = new ObjectMapper();
    if (args.length > 0 && args[0].equals("--base-aliases")) {
      for (String id : List.of("en-US", "zh-CN", "de-DE", "hi-IN")) {
        var lex = LexiconRegistry.getInstance().get(id);
        System.out.println(id + " " + (lex.isPresent() ? lex.get().getAliases() : "<missing>"));
      }
      return;
    }
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
        if (rawAlias != null) for (var e : rawAlias.entrySet()) aliasSet.put(SemanticTokenKind.valueOf(e.getKey()), List.copyOf(e.getValue()));
        Map<String, Object> vocab = (Map<String, Object>) req.get("vocabulary");
        VocabularyScopes scopes = vocab == null || vocab.isEmpty() ? null : VocabularyScopes.build(VocabularyLoader.loadFromMap(vocab));
        boolean allowStructural = Boolean.TRUE.equals(req.get("allowStructural"));
        InProcessCnlParser.ParseResult r = aliasSet.isEmpty()
            ? InProcessCnlParser.parse(src, locale, scopes)
            : InProcessCnlParser.parseWithUserAliases(src, locale, scopes, aliasSet, allowStructural);
        String core = CoreIrJson.serialize(r.core());
        byte[] h = MessageDigest.getInstance("SHA-256").digest(core.getBytes(StandardCharsets.UTF_8));
        out.put("ok", true);
        out.put("sha256", HexFormat.of().formatHex(h));
        out.put("coreJson", core);
      } catch (Throwable t) {
        out.put("ok", false);
        out.put("error", t.getClass().getSimpleName() + ": " + String.valueOf(t.getMessage()));
      }
      System.out.println(m.writeValueAsString(out));
    }
  }
}
