/**
 * Test stub for the editor's content API.
 *
 * `experience/cmsEditorApi` only exists inside the Marketing Cloud Next builder, so without this the
 * panel cannot be imported in Jest at all — which is why emailPreflight had no tests while the
 * engine had hundreds. Wired to jest.config.js via moduleNameMapper.
 *
 * `updateContent` is intentionally absent: the panel is read-only, and a stub for a function it must
 * never call would quietly make that mistake testable instead of impossible.
 */
import { createTestWireAdapter } from '@salesforce/wire-service-jest-util';

export const getContent = createTestWireAdapter();
export const getContext = createTestWireAdapter();
