import { ACCENTS, THEMES, type ThemePref } from '../../../shared/appearance'
import { LOCALE_NAMES, LOCALES } from '../../../shared/i18n'
import type { LanguagePref } from '../../../shared/api'
import { useI18n } from '../i18n'
import { KeyProtectionCard } from '../keyGuard'
import { api, Card, PageHeader, Switch, type PageProps } from '../ui'

export function Settings(props: PageProps) {
  const { state, run } = props
  const { t } = useI18n()

  return (
    <div className="page">
      <PageHeader title={t('nav.settings')} sub={t('settings.sub')} />

      <Card title={t('appearance.title')}>
        <div className="appearance">
          <div>
            <div className="appearance-label" id="theme-label">
              {t('appearance.theme')}
            </div>
            <div className="theme-options" role="radiogroup" aria-labelledby="theme-label">
              {THEMES.map((theme) => (
                <button
                  key={theme}
                  role="radio"
                  aria-checked={state.theme === theme}
                  className={`theme-option ${state.theme === theme ? 'active' : ''}`}
                  onClick={() => run(() => api.setTheme(theme))}
                >
                  <ThemeThumb theme={theme} />
                  {t(`appearance.${theme}`)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="appearance-label" id="accent-label">
              {t('appearance.accent')}
            </div>
            <div className="swatches" role="radiogroup" aria-labelledby="accent-label">
              {ACCENTS.map((accent) => (
                <button
                  key={accent}
                  role="radio"
                  aria-checked={state.accent === accent}
                  aria-label={t(`accent.${accent}`)}
                  title={t(`accent.${accent}`)}
                  data-accent={accent}
                  className={`swatch ${state.accent === accent ? 'active' : ''}`}
                  onClick={() => run(() => api.setAccent(accent))}
                />
              ))}
              <span className="accent-name">{t(`accent.${state.accent}`)}</span>
            </div>
            <p className="hint">{t('appearance.accentHint')}</p>
          </div>
        </div>
      </Card>

      <Card title={t('language.title')}>
        <div className="field-grid">
          <label htmlFor="language">{t('language.label')}</label>
          <div>
            <select
              id="language"
              className="input narrow-select"
              value={state.language}
              onChange={(e) => run(() => api.setLanguage(e.target.value as LanguagePref))}
            >
              <option value="system">{t('language.system')}</option>
              {LOCALES.map((l) => (
                <option key={l} value={l} lang={l}>
                  {LOCALE_NAMES[l]}
                </option>
              ))}
            </select>
            <p className="hint">{t('language.hint')}</p>
          </div>
        </div>
      </Card>

      <Card title={t('startup.title')}>
        <div className="switches">
          <Switch
            label={t('startup.launchAtLogin')}
            checked={state.startup.launchAtLogin}
            disabled={!state.startup.launchAtLoginSupported}
            onChange={(v) => run(() => api.setLaunchAtLogin(v))}
            hint={state.startup.launchAtLoginNote ?? t('startup.launchAtLoginHint')}
          />
          <Switch
            label={t('startup.startHidden')}
            checked={state.startup.startHidden}
            onChange={(v) => run(() => api.setStartHidden(v))}
            hint={t('startup.startHiddenHint')}
          />
        </div>
      </Card>

      <KeyProtectionCard {...props} />

      <Card title={t('usageData.title')}>
        <p className="hint">{t('usageData.hint', { days: state.usageRetentionDays })}</p>
        <div className="row card-foot">
          <button
            className="btn ghost danger"
            onClick={() => {
              if (confirm(t('usageData.clearConfirm'))) run(api.clearUsage)
            }}
          >
            {t('usageData.clear')}
          </button>
        </div>
      </Card>
    </div>
  )
}

/** A miniature window in light, dark, or both split diagonally for "system". */
function ThemeThumb({ theme }: { theme: ThemePref }) {
  return (
    <span className="theme-thumb" aria-hidden>
      {theme !== 'dark' && <MiniWindow />}
      {theme !== 'light' && <MiniWindow dark half={theme === 'system'} />}
    </span>
  )
}

function MiniWindow({ dark, half }: { dark?: boolean; half?: boolean }) {
  return (
    <span className={`mini ${dark ? 'dark' : ''} ${half ? 'half' : ''}`}>
      <span className="mini-side">
        <i />
        <i />
        <i />
      </span>
      <span className="mini-main">
        <span className="mini-card">
          <i />
          <i />
        </span>
        <span className="mini-pill" />
      </span>
    </span>
  )
}
