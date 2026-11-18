import type { PromptContext, ContextReport } from './context';
import type { ApprovedApplication, EditProposal, ApplyResult, ReviewDecision } from './edits';
import type { HarnessEvent } from './events';
import type { Request, Response } from './protocol';
import type { ForgeHarness } from './session';
import type { ToolRequest, ToolResponse } from './tools';

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Wire<T extends Json> = T;
type Operations = Omit<ForgeHarness, 'start' | 'dispose'>;
type Unwrap<T> = T extends AsyncIterable<infer E> ? E : Awaited<T>;
export type WireChecks = Wire<
  Parameters<Operations[keyof Operations]>[0] | Unwrap<ReturnType<Operations[keyof Operations]>>
  | Request<PromptContext> | Response<ContextReport> | ApprovedApplication | ApplyResult
  | ReviewDecision | ToolRequest | ToolResponse | HarnessEvent
>;
declare const proposal: EditProposal;
// @ts-expect-error Reviewable content cannot authorize an application.
const invalidApplication: ApprovedApplication = proposal;
// @ts-expect-error Applying zero accepted hunks is invalid.
const emptyApproval: ApprovedApplication['acceptedHunkIds'] = [];
// @ts-expect-error A terminal request requires command approval.
const terminalPolicy: Extract<ToolRequest, { tool: 'terminal' }>['approval'] = 'none';
// @ts-expect-error Text deltas do not carry actionable proposals.
type InvalidTextField = Extract<HarnessEvent, { t: 'text' }>['proposal'];

type Assert<T extends true> = T;
type Bridge = import('./edits').EditorBridge;
type ResultStatus = Awaited<ReturnType<Bridge['applyText']>>['status'];
type Expected = 'stale' | 'approval_missing' | 'failed_before_apply' | 'buffer_applied' | 'save_failed' | 'saved';
type AllOutcomes = Assert<[Expected, ResultStatus] extends [ResultStatus, Expected] ? true : false>;
type EventSaveState = Assert<Extract<HarnessEvent, { t: 'edit_applied' }>['result'] extends ApplyResult ? true : false>;
type GatherAndList = Assert<'context' | 'list' extends import('./tools').ReadOnlyTool ? true : false>;
type ApplyWire = Wire<Parameters<Bridge['applyText']>[0]>;
