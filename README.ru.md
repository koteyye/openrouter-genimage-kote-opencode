# openrouter-genimage-kote-opencode

Инструменты генерации и редактирования изображений через OpenRouter для OpenCode с опциональной fail-closed-маршрутизацией через KoteGateway. Основной сценарий — image-to-image: вложения, файлы проекта и публичные HTTPS URL передаются настроенной image-модели OpenRouter как упорядоченные `input_references`. Text-to-image доступен как дополнительный режим без визуальных референсов.

Плагин регистрирует:

- `openrouter_edit_image` — редактирование или создание по одному или нескольким визуальным референсам;
- `openrouter_generate_image` — новое изображение только по тексту;
- `openrouter_balance` — usage текущего ключа и, при наличии прав, credits аккаунта;
- `/openrouter-balance` — вызов balance tool без генерации изображения.

Операция может расходовать средства OpenRouter. Модель, API keys и режим маршрутизации задаются только в конфигурации и не являются аргументами tools.

## Установка

Добавьте npm-пакет tuple-записью в массив `plugin` файла `opencode.jsonc`, как показано ниже. OpenCode устанавливает npm-плагины из своей конфигурации.

Рекомендуемые permissions запрашивают подтверждение платной генерации, но разрешают проверку баланса:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "openrouter_edit_image": "ask",
    "openrouter_generate_image": "ask",
    "openrouter_balance": "allow"
  }
}
```

## Direct-конфигурация

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "openrouter-genimage-kote-opencode@0.1.0",
      {
        "routing": "direct",
        "model": "openai/gpt-image-1",
        "apiKey": "{env:OPENROUTER_API_KEY}",
        "managementApiKey": "{env:OPENROUTER_MANAGEMENT_API_KEY}",
        "outputDirectory": "assets/generated",
        "defaults": {
          "n": 1,
          "output_format": "png"
        }
      }
    ]
  ]
}
```

Direct mode отправляет HTTPS-запросы прямо на фиксированный OpenRouter API origin. Он не получает descriptor KoteGateway и не использует gateway как fallback.

## Proxy-конфигурация

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "openrouter-genimage-kote-opencode@0.1.0",
      {
        "routing": "proxy",
        "model": "openai/gpt-image-1",
        "apiKey": "{env:OPENROUTER_API_KEY}",
        "outputDirectory": "assets/generated",
        "input": {
          "maxReferences": 16,
          "maxFileBytes": 20971520,
          "maxTotalBytes": 52428800
        },
        "requestTimeoutMs": 300000
      }
    ]
  ]
}
```

Proxy mode получает подписанный descriptor KoteGateway и использует HTTPS CONNECT для каждого OpenRouter endpoint плагина. Режим fail-closed: ошибки bootstrap, подписи, CONNECT или timeout завершают запрос без прямого retry. OpenRouter keys, prompt, references и результат остаются внутри TLS-соединения до OpenRouter и не передаются как proxy headers.

## API keys

Создайте generation key OpenRouter и передайте его как `OPENROUTER_API_KEY`. Порядок разрешения: `apiKey` в options, затем environment variable. Отсутствующий ключ даёт `GENIMAGE_OPENROUTER_KEY_MISSING` до платного запроса.

Для полных credits аккаунта нужен management key: `managementApiKey` или `OPENROUTER_MANAGEMENT_API_KEY`. Generation key можно использовать для credits только если `/key` явно сообщает, что это management key. Не коммитьте ключи в `opencode.jsonc`; используйте подстановку OpenCode `{env:NAME}`.

## Выбор image-модели

Укажите OpenRouter model ID в `model`. Модель намеренно недоступна в arguments tools, поэтому агент не может незаметно выбрать другую или более дорогую модель. Перед первым платным запросом плагин получает capabilities и проверяет image output, image input для edit и переданные параметры. Автоматической подмены модели нет.

Конкретный provider endpoint может поддерживать меньше параметров или результатов, чем общие лимиты OpenRouter Images API.

## Image-to-image — основной сценарий

`openrouter_edit_image` требует хотя бы одно изображение и никогда не переходит в text-to-image. Если `references` не передан, используются все image attachments родительского user message с сохранением порядка. При их отсутствии возвращается `GENIMAGE_REFERENCE_REQUIRED`.

### Attached images

Приложите изображения к текущему user message и попросите OpenCode изменить их. Для явного выбора используется нумерация с единицы только среди image attachments:

```json
{
  "prompt": "Reference image 1 defines the character. Reference image 2 defines clothing only. Preserve the face and illustration style.",
  "references": [
    { "type": "message_attachment", "index": 1 },
    { "type": "message_attachment", "index": 2 }
  ]
}
```

Поддерживаются доверенные представления attachments, полученные от OpenCode. Произвольные `file:`, `data:` и `blob:` URL в tool arguments запрещены.

### Project files

Пути задаются относительно текущего OpenCode worktree:

```json
{
  "prompt": "Preserve the isometric angle, proportions, and palette. Create a damaged version with broken boards.",
  "references": [
    { "type": "project_file", "path": "assets/props/crate.png" }
  ],
  "output_path": "assets/props/crate-damaged.png"
}
```

PNG, JPEG и WebP принимаются после проверки размера и magic bytes. Абсолютные пути, traversal, symlink escape, директории и файлы за пределами worktree отклоняются. Исходники и существующие результаты не перезаписываются.

### Несколько references и HTTPS URL

Порядок references сохраняется точно. Первый считается основным; роль каждого изображения нужно описать в prompt — плагин не сортирует, не склеивает и не придумывает роли.

```json
{
  "prompt": "Reference 1 defines identity and face. Reference 2 defines clothing only. Reference 3 defines palette and lighting.",
  "references": [
    { "type": "project_file", "path": "assets/character.png" },
    { "type": "message_attachment", "index": 1 },
    { "type": "https_url", "url": "https://example.com/palette.webp" }
  ]
}
```

Разрешены только публичные HTTPS URL без credentials. Явные HTTPS references передаются OpenRouter без изменения; локальные изображения кодируются в памяти как base64 data URL. Внешнее хранилище не требуется.

Подробнее: [Image-to-image](docs/image-to-image.md).

## Text-to-image

`openrouter_generate_image` используется только для полностью нового изображения без визуального референса. Он принимает prompt и output parameters, но не references, paths, attachment indexes, base64 или URL.

## Установка skill

Skill входит в npm tarball, но OpenCode ищет skills в директориях проекта или пользователя. Поэтому установите его явно:

```bash
npx openrouter-genimage-kote-opencode install-skill
npx openrouter-genimage-kote-opencode check-skill
```

Глобально для пользователя:

```bash
npx openrouter-genimage-kote-opencode install-skill --global
npx openrouter-genimage-kote-opencode check-skill --global
```

Project install пишет `.opencode/skills/openrouter-image-generation/SKILL.md`; global install всегда пишет `~/.config/opencode/skills/openrouter-image-generation/SKILL.md`, в том числе на Windows. Одинаковый SHA-256 означает no-op. `check-skill` завершается с nonzero code для отсутствующего или изменённого skill. `--force` нужен только для атомарной замены локально изменённого skill. CLI не использует postinstall, не требует API key и не обращается в сеть.

## Balance и usage

Запустите `/openrouter-balance` или `openrouter_balance`. Результат разделяет два понятия:

- `/key` возвращает usage и spending limit настроенного API key, включая remaining API-key limit;
- `/credits` возвращает total credits и total usage аккаунта и требует management key.

Оставшийся лимит отдельного ключа — не баланс аккаунта OpenRouter. Без management authorization account credits показываются как unavailable. Если `/credits` упал, успешные данные `/key` всё равно возвращаются.

## Безопасность

- Production origin фиксирован: `https://openrouter.ai/api/v1`; пользовательские base URLs запрещены.
- Redirects отклоняются. Платный `POST /images` автоматически не повторяется.
- Proxy mode работает fail-closed и не повторяет запрос напрямую.
- Плагин не заменяет `globalThis.fetch` и не перехватывает другие providers.
- Keys, полный prompt, base64, binary data, полный upstream body и URL с query не попадают в logs/metadata.
- Input/output paths ограничены worktree; real paths проверяются против symlink escape.
- Результаты пишутся атомарно и не перезаписывают исходники или существующие файлы.

Подробнее: [Безопасность](docs/security.md) и [SECURITY.md](SECURITY.md).

## Ограничения версии 0.1.0

Нет masks и гарантированного локального inpainting, интерактивного редактора, LoRA, video, streaming, SVG, provider-specific options, автоматической покупки credits, автоматического выбора модели, скрытых fallback и внешнего object storage. Поддерживаются только PNG, JPEG и WebP. Seed не гарантирует воспроизводимость между providers. OpenRouter может вернуть меньше изображений, чем запрошено; валидные partial results сохраняются с warning.

## Troubleshooting

- `GENIMAGE_REFERENCE_REQUIRED`: приложите изображение или передайте минимум один ordered reference в `openrouter_edit_image`.
- `GENIMAGE_MODEL_DOES_NOT_SUPPORT_IMAGE_INPUT`: настройте image-to-image capable model; плагин не сменит её сам.
- `GENIMAGE_PARAMETER_UNSUPPORTED`: уберите неподдерживаемый argument/default либо настройте совместимую модель.
- `GENIMAGE_OPENROUTER_KEY_MISSING`: передайте `OPENROUTER_API_KEY` процессу OpenCode либо задайте `apiKey` через environment substitution.
- `GENIMAGE_*_TOO_LARGE` / `GENIMAGE_TOTAL_REFERENCE_SIZE_EXCEEDED`: сожмите/уменьшите inputs, сократите references или используйте публичный HTTPS URL.
- `GENIMAGE_GATEWAY_*`: исправьте KoteGateway/bootstrap/connectivity; proxy mode намеренно не использует direct fallback.
- Ошибка output path: используйте относительный путь внутри worktree, который не существует и не совпадает с source image.

Полная таблица: [Troubleshooting](docs/troubleshooting.md). Также см. [Configuration](docs/configuration.md) и [Testing](docs/testing.md).

## Статус совместимости

- Baseline OpenCode smoke tests: **1.18.21**. CI настроен на baseline и latest, но attachments в TUI и Desktop всё ещё требуют ручной release-проверки; Web — если доступен.
- `@koteye/kote-gateway-opencode` **0.1.1** ограничивает совместимость `@opencode-ai/plugin`/OpenCode версией **1.18.18**, тогда как этот пакет нацелен на **1.18.21**. Поэтому текущая сборка фиксирует SDK **1.18.18** и не может считаться полностью готовой к публикации под baseline, пока reusable gateway core не будет выпущен отдельно без OpenCode peer либо диапазон gateway package не обновится.
- Synthetic TLS/CONNECT tests проходят для signed bootstrap, fail-closed routing, одного CONNECT и обоих порядков загрузки. Они не снимают package-range blocker выше и необходимость реальных client smoke checks.
- Package объявляет Node.js 20+. Реализация рассчитана на Bun и Windows/macOS/Linux, но release artifacts должны быть проверены на поддерживаемой матрице.

## Документация

- [Архитектура](docs/architecture.md)
- [Конфигурация](docs/configuration.md)
- [Image-to-image](docs/image-to-image.md)
- [Безопасность](docs/security.md)
- [Тестирование](docs/testing.md)
- [Troubleshooting](docs/troubleshooting.md)
- [English README](README.md)

## Лицензия

MIT. См. [LICENSE](LICENSE) и [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
