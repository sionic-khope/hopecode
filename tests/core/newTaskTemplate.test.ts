import { describe, expect, it } from 'vitest';
import { fillNewTaskTemplate, formatDateYMD } from '../../src/core/newTaskTemplate';

describe('formatDateYMD', () => {
  it('formats local date parts as YYYY-MM-DD, zero-padded', () => {
    expect(formatDateYMD(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(formatDateYMD(new Date(2025, 11, 31))).toBe('2025-12-31');
  });
});

describe('fillNewTaskTemplate', () => {
  it('substitutes {project} and {date}', () => {
    const out = fillNewTaskTemplate('작업: {project} / {date}', 'hopecode', new Date(2026, 8, 26));
    expect(out).toBe('작업: hopecode / 2026-09-26');
  });

  it('replaces {project} with an empty string when no project is selected', () => {
    expect(fillNewTaskTemplate('폴더: {project}', null, new Date(2026, 0, 1))).toBe('폴더: ');
  });

  it('substitutes every occurrence of a placeholder', () => {
    expect(fillNewTaskTemplate('{project}-{project}', 'a', new Date(2026, 0, 1))).toBe('a-a');
  });

  it('leaves a template without placeholders untouched', () => {
    const template = '작업 시작 전에 다음을 순서대로 해 주세요.\n1. git pull';
    expect(fillNewTaskTemplate(template, 'x', new Date())).toBe(template);
  });
});
