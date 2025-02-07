import {controller, target} from '@github/catalyst'
import '@oddbird/popover-polyfill'
import type {IncludeFragmentElement} from '@github/include-fragment-element'

type SelectVariant = 'none' | 'single' | 'multiple' | null
type SelectedItem = {
  label: string | null | undefined
  value: string | null | undefined
  element: Element
}

const validSelectors = ['[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]']
const menuItemSelectors = validSelectors.map(selector => `:not([hidden]) > ${selector}`)

@controller
export class ActionMenuElement extends HTMLElement {
  @target
  includeFragment: IncludeFragmentElement

  #abortController: AbortController
  #originalLabel = ''
  #inputName = ''
  #invokerBeingClicked = false

  get selectVariant(): SelectVariant {
    return this.getAttribute('data-select-variant') as SelectVariant
  }

  set selectVariant(variant: SelectVariant) {
    if (variant) {
      this.setAttribute('data-select-variant', variant)
    } else {
      this.removeAttribute('variant')
    }
  }

  get dynamicLabelPrefix(): string {
    const prefix = this.getAttribute('data-dynamic-label-prefix')
    if (!prefix) return ''
    return `${prefix}:`
  }

  set dynamicLabelPrefix(value: string) {
    this.setAttribute('data-dynamic-label', value)
  }

  get dynamicLabel(): boolean {
    return this.hasAttribute('data-dynamic-label')
  }

  set dynamicLabel(value: boolean) {
    this.toggleAttribute('data-dynamic-label', value)
  }

  get popoverElement(): HTMLElement | null {
    return (this.invokerElement?.popoverTargetElement as HTMLElement) || null
  }

  get invokerElement(): HTMLButtonElement | null {
    const id = this.querySelector('[role=menu]')?.id
    if (!id) return null
    for (const el of this.querySelectorAll(`[aria-controls]`)) {
      if (el.getAttribute('aria-controls') === id) {
        return el as HTMLButtonElement
      }
    }
    return null
  }

  get invokerLabel(): HTMLElement | null {
    if (!this.invokerElement) return null
    return this.invokerElement.querySelector('.Button-label')
  }

  get selectedItems(): SelectedItem[] {
    const selectedItems = this.querySelectorAll('[aria-checked=true]')
    const results: SelectedItem[] = []

    for (const selectedItem of selectedItems) {
      const labelEl = selectedItem.querySelector('.ActionListItem-label')

      results.push({
        label: labelEl?.textContent,
        value: selectedItem?.getAttribute('data-value'),
        element: selectedItem
      })
    }

    return results
  }

  connectedCallback() {
    const {signal} = (this.#abortController = new AbortController())
    this.addEventListener('keydown', this, {signal})
    this.addEventListener('click', this, {signal})
    this.addEventListener('mouseover', this, {signal})
    this.addEventListener('focusout', this, {signal})
    this.addEventListener('mousedown', this, {signal})
    this.#setDynamicLabel()
    this.#updateInput()
    this.#softDisableItems()

    if (this.includeFragment) {
      this.includeFragment.addEventListener('include-fragment-replaced', this, {
        signal
      })
    }
  }

  #softDisableItems() {
    const {signal} = this.#abortController

    for (const item of this.#items) {
      item.addEventListener('click', this.#potentiallyDisallowActivation.bind(this), {signal})
      item.addEventListener('keydown', this.#potentiallyDisallowActivation.bind(this), {signal})
    }
  }

  #potentiallyDisallowActivation(event: Event) {
    if (!this.#isActivation(event)) return

    const item = (event.target as HTMLElement).closest(menuItemSelectors.join(','))
    if (!item) return

    if (item.getAttribute('aria-disabled')) {
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    }
  }

  disconnectedCallback() {
    this.#abortController.abort()
  }

  #isKeyboardActivation(event: Event): boolean {
    return this.#isKeyboardActivationViaEnter(event) || this.#isKeyboardActivationViaSpace(event)
  }

  #isKeyboardActivationViaEnter(event: Event): boolean {
    return (
      event instanceof KeyboardEvent &&
      event.type === 'keydown' &&
      !(event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) &&
      event.key === 'Enter'
    )
  }

  #isKeyboardActivationViaSpace(event: Event): boolean {
    return (
      event instanceof KeyboardEvent &&
      event.type === 'keydown' &&
      !(event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) &&
      event.key === ' '
    )
  }

  #isMouseActivation(event: Event): boolean {
    return event instanceof MouseEvent && event.type === 'click'
  }

  #isActivation(event: Event): boolean {
    return this.#isMouseActivation(event) || this.#isKeyboardActivation(event)
  }

  handleEvent(event: Event) {
    const targetIsInvoker = this.invokerElement?.contains(event.target as HTMLElement)
    const eventIsActivation = this.#isActivation(event)

    if (targetIsInvoker && event.type === 'mousedown') {
      this.#invokerBeingClicked = true
      return
    }

    // Prevent safari bug that dismisses menu on mousedown instead of allowing
    // the click event to propagate to the button
    if (event.type === 'mousedown') {
      event.preventDefault()
      return
    }

    if (targetIsInvoker && eventIsActivation) {
      this.#handleInvokerActivated(event)
      this.#invokerBeingClicked = false
      return
    }

    if (event.type === 'focusout') {
      if (this.#invokerBeingClicked) return

      // Give the browser time to focus the next element
      requestAnimationFrame(() => {
        if (!this.contains(document.activeElement) || document.activeElement === this.invokerElement) {
          this.#handleFocusOut()
        }
      })

      return
    }

    const item = (event.target as Element).closest(menuItemSelectors.join(','))
    const targetIsItem = item !== null

    if (targetIsItem && eventIsActivation) {
      const dialogInvoker = item.closest('[data-show-dialog-id]')

      if (dialogInvoker) {
        const dialog = this.ownerDocument.getElementById(dialogInvoker.getAttribute('data-show-dialog-id') || '')

        if (dialog && this.contains(dialogInvoker) && this.contains(dialog)) {
          this.#handleDialogItemActivated(event, dialog)
          return
        }
      }

      this.#activateItem(event, item)
      this.#handleItemActivated(event, item)

      // Pressing the space key on a button will cause the page to scroll unless preventDefault()
      // is called. Unfortunately, calling preventDefault() will also skip form submission. The
      // code below therefore only calls preventDefault() if the button submits a form and the
      // button is being activated by the space key.
      if (item.getAttribute('type') === 'submit' && this.#isKeyboardActivationViaSpace(event)) {
        event.preventDefault()
        item.closest('form')?.submit()
      }

      return
    }

    if (event.type === 'include-fragment-replaced') {
      this.#handleIncludeFragmentReplaced()
    }
  }

  #handleInvokerActivated(event: Event) {
    event.preventDefault()
    event.stopPropagation()

    if (this.#isOpen()) {
      this.#hide()
    } else {
      this.#show()
      this.#firstItem?.focus()
    }
  }

  #handleDialogItemActivated(event: Event, dialog: HTMLElement) {
    this.querySelector<HTMLElement>('.ActionListWrap')!.style.display = 'none'
    const dialog_controller = new AbortController()
    const {signal} = dialog_controller
    const handleDialogClose = () => {
      dialog_controller.abort()
      this.querySelector<HTMLElement>('.ActionListWrap')!.style.display = ''
      if (this.#isOpen()) {
        this.#hide()
      }
    }
    dialog.addEventListener('close', handleDialogClose, {signal})
    dialog.addEventListener('cancel', handleDialogClose, {signal})
  }

  #handleItemActivated(event: Event, item: Element) {
    // Hide popover after current event loop to prevent changes in focus from
    // altering the target of the event. Not doing this specifically affects
    // <a> tags. It causes the event to be sent to the currently focused element
    // instead of the anchor, which effectively prevents navigation, i.e. it
    // appears as if hitting enter does nothing. Curiously, clicking instead
    // works fine.
    if (this.selectVariant !== 'multiple') {
      setTimeout(() => {
        if (this.#isOpen()) {
          this.#hide()
        }
      })
    }

    // The rest of the code below deals with single/multiple selection behavior, and should not
    // interfere with events fired by menu items whose behavior is specified outside the library.
    if (this.selectVariant !== 'multiple' && this.selectVariant !== 'single') return

    const ariaChecked = item.getAttribute('aria-checked')
    const checked = ariaChecked !== 'true'

    if (this.selectVariant === 'single') {
      // Only check, never uncheck here. Single-select mode does not allow unchecking a checked item.
      if (checked) {
        item.setAttribute('aria-checked', 'true')
      }

      for (const checkedItem of this.querySelectorAll('[aria-checked]')) {
        if (checkedItem !== item) {
          checkedItem.setAttribute('aria-checked', 'false')
        }
      }

      this.#setDynamicLabel()
    } else {
      // multi-select mode allows unchecking a checked item
      item.setAttribute('aria-checked', `${checked}`)
    }

    this.#updateInput()
  }

  #activateItem(event: Event, item: Element) {
    const eventWillActivateByDefault =
      (event instanceof MouseEvent && event.type === 'click') ||
      (event instanceof KeyboardEvent &&
        event.type === 'keydown' &&
        !(event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) &&
        event.key === 'Enter')

    // if the event will result in activating the current item by default, i.e. is a
    // mouse click or keyboard enter, bail out
    if (eventWillActivateByDefault) return

    // otherwise, event will not result in activation by default, so we stop it and
    // simulate a click
    event.stopPropagation()
    const elem = item as HTMLElement
    elem.click()
  }

  #handleIncludeFragmentReplaced() {
    if (this.#firstItem) this.#firstItem.focus()
    this.#softDisableItems()
  }

  // Close when focus leaves menu
  #handleFocusOut() {
    this.#hide()
  }

  #show() {
    this.popoverElement?.showPopover()
  }

  #hide() {
    this.popoverElement?.hidePopover()
  }

  #isOpen() {
    return this.popoverElement?.matches(':popover-open')
  }

  #setDynamicLabel() {
    if (!this.dynamicLabel) return
    const invokerLabel = this.invokerLabel
    if (!invokerLabel) return
    this.#originalLabel ||= invokerLabel.textContent || ''
    const itemLabel = this.querySelector('[aria-checked=true] .ActionListItem-label')
    if (itemLabel && this.dynamicLabel) {
      const prefixSpan = document.createElement('span')
      prefixSpan.classList.add('color-fg-muted')
      const contentSpan = document.createElement('span')
      prefixSpan.textContent = this.dynamicLabelPrefix
      contentSpan.textContent = itemLabel.textContent || ''
      invokerLabel.replaceChildren(prefixSpan, contentSpan)
    } else {
      invokerLabel.textContent = this.#originalLabel
    }
  }

  #updateInput() {
    if (this.selectVariant === 'single') {
      const input = this.querySelector(`[data-list-inputs=true] input`) as HTMLInputElement | null
      if (!input) return

      const selectedItem = this.selectedItems[0]

      if (selectedItem) {
        input.value = (selectedItem.value || selectedItem.label || '').trim()
        input.removeAttribute('disabled')
      } else {
        input.setAttribute('disabled', 'disabled')
      }
    } else if (this.selectVariant !== 'none') {
      // multiple select variant
      const inputList = this.querySelector('[data-list-inputs=true]')
      if (!inputList) return

      const inputs = inputList.querySelectorAll('input')

      if (inputs.length > 0) {
        this.#inputName ||= (inputs[0] as HTMLInputElement).name
      }

      for (const selectedItem of this.selectedItems) {
        const newInput = document.createElement('input')
        newInput.setAttribute('data-list-input', 'true')
        newInput.type = 'hidden'
        newInput.autocomplete = 'off'
        newInput.name = this.#inputName
        newInput.value = (selectedItem.value || selectedItem.label || '').trim()

        inputList.append(newInput)
      }

      for (const input of inputs) {
        input.remove()
      }
    }
  }

  get #firstItem(): HTMLElement | null {
    return this.querySelector(menuItemSelectors.join(','))
  }

  get #items(): HTMLElement[] {
    return Array.from(this.querySelectorAll(menuItemSelectors.join(',')))
  }
}

if (!window.customElements.get('action-menu')) {
  window.ActionMenuElement = ActionMenuElement
  window.customElements.define('action-menu', ActionMenuElement)
}

declare global {
  interface Window {
    ActionMenuElement: typeof ActionMenuElement
  }
}
