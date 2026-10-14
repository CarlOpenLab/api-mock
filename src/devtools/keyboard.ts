/** 键盘处理的共用判断。 */

/** 焦点在输入类控件里时，方向键和回车该归它们，不该被面板抢走。 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
