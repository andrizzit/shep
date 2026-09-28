import { BUILTIN_TEMPLATES, MESSAGES, validateConfigShape, validatePrompt } from './contracts.mjs';

export function validateTemplates(overrides) {
  const result = validateConfigShape({ templates: overrides });
  return { errors: result.errors.map(issue => ({ ...issue, path: issue.path.replace(/^templates\.?/, '') })), warnings: result.warnings };
}

export function expandTemplate(name, inputTask, templates = BUILTIN_TEMPLATES) {
  if (validatePrompt(inputTask).length) return { error: inputTask?.trim?.() ? MESSAGES.invalidPrompt : MESSAGES.emptyTask, code: 'invalid_prompt' };
  if (name === null || name === undefined) return inputTask;
  const text = Object.hasOwn(templates, name) ? templates[name] : null;
  if (typeof text !== 'string' || !text || validateTemplates({ [name]: text }).errors.length) return { error: `Unknown template “${name}”.`, code: 'unknown_template' };
  // A replacement callback preserves literal $&, $1 and all other task bytes.
  const expanded = text.replaceAll('{task}', () => inputTask);
  return validatePrompt(expanded).length ? { error: MESSAGES.invalidPrompt, code: 'invalid_prompt' } : expanded;
}
