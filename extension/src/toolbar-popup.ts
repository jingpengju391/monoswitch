/** Keep the popup attached to the browser by activating its destination tab first. */
export async function openToolbarPopup(sourceId: number, api = chrome): Promise<void> {
  const source = await api.tabs.get(sourceId)
  const contexts = await api.runtime.getContexts({ contextTypes: [api.runtime.ContextType.TAB], tabIds: [sourceId] })
  if (!contexts.some(context => context.documentUrl?.split('?')[0] === api.runtime.getURL('index.html'))) {
    throw new Error('Invalid source tab')
  }
  const tabs = await api.tabs.query({ windowId: source.windowId })
  const destination = tabs.find(tab => tab.id !== sourceId && tab.id !== undefined)
  let createdId: number | undefined
  try {
    if (destination?.id !== undefined) {
      await api.tabs.update(destination.id, { active: true })
    } else {
      const created = await api.tabs.create({ windowId: source.windowId, url: 'chrome://newtab', active: true })
      createdId = created.id
    }
    await api.action.openPopup({ windowId: source.windowId })
    // The source is now inactive; removing it does not dismiss the toolbar popup.
    await api.tabs.remove(sourceId)
  } catch (error) {
    await api.tabs.update(sourceId, { active: true }).catch(() => {})
    if (createdId !== undefined) await api.tabs.remove(createdId).catch(() => {})
    throw error
  }
}
