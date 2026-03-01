import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { CalendarDays, ChevronLeft, ChevronRight, Download, LogOut, Maximize2, Moon, Search, Sun, Trash2, Upload, X } from 'lucide-react'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import html2canvas from 'html2canvas'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'

const lightPalette = ['#2563eb', '#4f46e5', '#0d9488', '#d97706', '#9333ea', '#db2777']
const darkPalette = ['#60a5fa', '#818cf8', '#2dd4bf', '#f59e0b', '#c084fc', '#f472b6']
const DEFAULT_SORT_CONFIG = { field: 'fecha', direction: 'desc' }
const FALLBACK_PROD_API_URL = 'https://datam-backend-production.up.railway.app'
const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL
  || (typeof window !== 'undefined' && window.location.hostname.includes('netlify.app') ? FALLBACK_PROD_API_URL : '')
).replace(/\/$/, '')

function withApiBase(path) {
  if (!API_BASE_URL) return path
  if (path.startsWith('http://') || path.startsWith('https://')) return path
  return `${API_BASE_URL}${path}`
}

function getCookieValue(name) {
  if (typeof document === 'undefined') return ''
  const encodedName = `${encodeURIComponent(name)}=`
  const parts = document.cookie.split(';')
  for (const part of parts) {
    const item = part.trim()
    if (item.startsWith(encodedName)) {
      return decodeURIComponent(item.slice(encodedName.length))
    }
  }
  return ''
}

function withCsrfHeaders(options = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = new Headers(options.headers || {})
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfToken = getCookieValue('csrf_token')
    if (csrfToken && !headers.has('x-csrf-token')) {
      headers.set('x-csrf-token', csrfToken)
    }
  }
  return { ...options, headers }
}

async function api(path, options = {}, retry = true) {
  const requestOptions = withCsrfHeaders(options)
  const response = await fetch(withApiBase(path), { credentials: 'include', ...requestOptions })

  if (response.status === 401 && retry) {
    const refresh = await fetch(withApiBase('/api/auth/refresh'), { method: 'POST', credentials: 'include' })
    if (refresh.ok) return api(path, options, false)
  }

  if (!response.ok) {
    const payload = await response.json().catch(async () => {
      const rawText = await response.text().catch(() => '')
      if (rawText.startsWith('<!DOCTYPE') || rawText.startsWith('<html')) {
        return { detail: 'La API devolvió HTML. Revisa VITE_API_BASE_URL en Netlify y CORS en Railway.' }
      }
      return { detail: 'Error inesperado' }
    })
    throw new Error(payload.detail || 'Error')
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    const rawText = await response.text().catch(() => '')
    if (rawText.startsWith('<!DOCTYPE') || rawText.startsWith('<html')) {
      throw new Error('La API devolvió HTML en lugar de JSON. Verifica VITE_API_BASE_URL y CORS.')
    }
    throw new Error('Respuesta no JSON desde la API')
  }

  return response.json()
}

function buildQuery(filters) {
  const params = new URLSearchParams()
  if (filters.companyId) params.set('company_id', String(filters.companyId))
  if (filters.vaultId) params.set('vault_id', String(filters.vaultId))
  if (filters.search) params.set('search', filters.search)
  if (filters.category) params.set('category', filters.category)
  if (filters.subcategory) params.set('subcategory', filters.subcategory)
  if (filters.project) params.set('project', filters.project)
  if (filters.account) params.set('account', filters.account)
  if (filters.projectCode) params.set('project_code', filters.projectCode)
  if (filters.year) params.set('year', filters.year)
  if (filters.monthNumber) params.set('month_number', filters.monthNumber)
  if (filters.flowType) params.set('flow_type', filters.flowType)

  let dateFrom = filters.dateFrom
  let dateTo = filters.dateTo

  if (filters.month) {
    const [yearText, monthText] = filters.month.split('-')
    const year = Number(yearText)
    const month = Number(monthText)
    if (!Number.isNaN(year) && !Number.isNaN(month)) {
      const firstDay = `${filters.month}-01`
      const lastDay = new Date(year, month, 0).getDate()
      const lastDayText = String(lastDay).padStart(2, '0')
      const monthEnd = `${filters.month}-${lastDayText}`
      if (!dateFrom) dateFrom = firstDay
      if (!dateTo) dateTo = monthEnd
    }
  }

  if (filters.dateExact) {
    dateFrom = filters.dateExact
    dateTo = filters.dateExact
  }

  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  return params.toString()
}

function currency(value) {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
    maximumFractionDigits: 0,
  }).format(value || 0)
}

function compactCurrency(value) {
  return new Intl.NumberFormat('es-CL', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value || 0)
}

function periodLabel(filters) {
  if (filters.dateExact) return `Fecha exacta: ${filters.dateExact}`
  if (filters.dateFrom || filters.dateTo) return `Rango: ${filters.dateFrom || 'inicio'} a ${filters.dateTo || 'hoy'}`
  if (filters.year && filters.monthNumber) return `Periodo: ${filters.year}-${String(filters.monthNumber).padStart(2, '0')}`
  if (filters.year) return `Año: ${filters.year}`
  if (filters.month) return `Mes: ${filters.month}`
  return 'Periodo: acumulado'
}

function formatFileSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function escapeCsvValue(value) {
  if (value === null || value === undefined) return '""'
  const text = String(value).replaceAll('"', '""')
  return `"${text}"`
}

function rowsToCsv(headers, rows) {
  const headerRow = headers.map((header) => escapeCsvValue(header)).join(',')
  const dataRows = rows.map((row) => row.map((cell) => escapeCsvValue(cell)).join(','))
  return [headerRow, ...dataRows].join('\n')
}

function downloadCsv(filename, csvContent) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function KpiCard({ label, value, colorClass, isDark }) {
  const valueClass = colorClass || (isDark ? 'text-slate-100' : 'text-slate-800')
  return (
    <Card className={`p-4 ${isDark ? 'border-slate-800/90 bg-slate-900/75 text-slate-100' : 'border-slate-200 bg-white text-slate-900 shadow-sm'}`}>
      <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
      <p className={`mt-2 text-xl font-semibold ${valueClass}`}>{value}</p>
    </Card>
  )
}

function App() {
  const categoryChartRef = useRef(null)
  const flowChartRef = useRef(null)
  const monthChartRef = useRef(null)

  const [theme, setTheme] = useState('dark')
  const [user, setUser] = useState(null)
  const [authMessage, setAuthMessage] = useState('')
  const [companyMessage, setCompanyMessage] = useState('')
  const [uploadMessage, setUploadMessage] = useState('')
  const [uploadMessageType, setUploadMessageType] = useState('info')
  const [selectedUploadFile, setSelectedUploadFile] = useState(null)
  const [categories, setCategories] = useState([])
  const [subcategories, setSubcategories] = useState([])
  const [projects, setProjects] = useState([])
  const [accounts, setAccounts] = useState([])
  const [projectCodes, setProjectCodes] = useState([])
  const [years, setYears] = useState([])
  const [uploadsHistory, setUploadsHistory] = useState([])
  const [companies, setCompanies] = useState([])
  const [vaults, setVaults] = useState([])
  const [activeCompanyId, setActiveCompanyId] = useState('')
  const [activeVaultId, setActiveVaultId] = useState('')
  const [records, setRecords] = useState([])
  const [summary, setSummary] = useState({ by_category: [], by_flow: [], by_month: [] })
  const [report, setReport] = useState({ totals: {}, top_categories: [], insights: [] })
  const [reportRows, setReportRows] = useState([])
  const [pagination, setPagination] = useState({ page: 1, page_size: 100, total: 0, total_pages: 1 })

  const [loading, setLoading] = useState(false)
  const [authLoading, setAuthLoading] = useState(false)
  const [uploadLoading, setUploadLoading] = useState(false)

  const [loginForm, setLoginForm] = useState({ username: '', password: '' })
  const [registerForm, setRegisterForm] = useState({ full_name: '', username: '', password: '' })
  const [companyForm, setCompanyForm] = useState({ name: '', legal_name: '', tax_id: '', business_line: '' })
  const [vaultForm, setVaultForm] = useState({ name: '', period_type: 'custom' })
  const [authMode, setAuthMode] = useState('login')
  const [filters, setFilters] = useState({ companyId: '', vaultId: '', search: '', category: '', subcategory: '', project: '', account: '', projectCode: '', year: '', monthNumber: '', flowType: '', month: '', dateExact: '', dateFrom: '', dateTo: '' })
  const [activeTab, setActiveTab] = useState('home')
  const [chartView, setChartView] = useState('all')
  const [fullScreenChart, setFullScreenChart] = useState(null)
  const [compareFrom, setCompareFrom] = useState('')
  const [compareTo, setCompareTo] = useState('')
  const [visibleColumns, setVisibleColumns] = useState({
    posicion: true,
    mes: true,
    fecha: true,
    cuenta: true,
    categoria: true,
    subcategoria: true,
    proyecto: true,
    codigo_proyecto: true,
    emisor_receptor: false,
    descripcion: true,
    tipo_documento: false,
    numero_documento: false,
    tipo: true,
    verificado: false,
    comentarios: false,
    monto: true,
    saldo: true,
    archivo_origen: false,
  })
  const [sortConfig, setSortConfig] = useState(DEFAULT_SORT_CONFIG)

  const isDark = theme === 'dark'
  const palette = isDark ? darkPalette : lightPalette

  const sectionBgClass = isDark
    ? 'bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100'
    : 'bg-gradient-to-b from-slate-100 via-blue-50/30 to-indigo-50/40 text-slate-900'
  const selectClass = isDark
    ? 'h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20'
    : 'h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-800 shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20'
  const cardToneClass = isDark ? 'border-slate-800/90 bg-slate-900/75 text-slate-100' : 'border-slate-200 bg-white text-slate-900 shadow-sm'
  const inputToneClass = isDark
    ? 'border-slate-700 bg-slate-900 text-slate-100 placeholder:text-slate-500'
    : 'border-slate-300 bg-white text-slate-900 placeholder:text-slate-500 shadow-sm'
  const ghostButtonToneClass = isDark
    ? 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-600 hover:bg-slate-800'
    : 'border-slate-300 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50'
  const secondaryButtonToneClass = isDark
    ? 'border-slate-700 bg-slate-800 text-slate-100 hover:border-slate-600 hover:bg-slate-700'
    : 'border-slate-300 bg-slate-100 text-slate-800 hover:border-blue-300 hover:bg-blue-50/60'

  const kpis = useMemo(() => {
    const income = summary.by_flow.find((item) => item.label === 'ingreso')?.value || 0
    const expense = summary.by_flow.find((item) => item.label === 'egreso')?.value || 0
    return { income, expense, balance: income - expense, operations: pagination.total }
  }, [summary, pagination.total])

  const currentPeriod = useMemo(() => periodLabel(filters), [filters])

  const monthComparison = useMemo(() => {
    const months = [...(summary.by_month || [])]
    if (months.length < 2) return null
    const sorted = months.sort((first, second) => String(first.label).localeCompare(String(second.label)))
    const current = sorted[sorted.length - 1]
    const previous = sorted[sorted.length - 2]
    const delta = (current.value || 0) - (previous.value || 0)
    const deltaPct = (previous.value || 0) !== 0 ? (delta / previous.value) * 100 : 0
    return { current, previous, delta, deltaPct }
  }, [summary.by_month])

  const rangeComparison = useMemo(() => {
    if (!compareFrom || !compareTo) return null
    const start = compareFrom <= compareTo ? compareFrom : compareTo
    const end = compareFrom <= compareTo ? compareTo : compareFrom
    const months = (summary.by_month || []).filter((item) => item.label >= start && item.label <= end)
    const total = months.reduce((accumulator, item) => accumulator + (item.value || 0), 0)
    return { start, end, months: months.length, total }
  }, [summary.by_month, compareFrom, compareTo])

  const visibleColumnKeys = useMemo(() => Object.entries(visibleColumns).filter(([, enabled]) => enabled).map(([key]) => key), [visibleColumns])
  const isDefaultSort = sortConfig.field === DEFAULT_SORT_CONFIG.field && sortConfig.direction === DEFAULT_SORT_CONFIG.direction

  const sortedRecords = useMemo(() => {
    const data = [...records]
    const { field, direction } = sortConfig
    const multiplier = direction === 'asc' ? 1 : -1

    data.sort((first, second) => {
      const firstValue = first[field]
      const secondValue = second[field]

      if (field === 'monto' || field === 'saldo') {
        return ((Number(firstValue) || 0) - (Number(secondValue) || 0)) * multiplier
      }

      if (field === 'fecha') {
        const firstDate = new Date(firstValue).getTime() || 0
        const secondDate = new Date(secondValue).getTime() || 0
        return (firstDate - secondDate) * multiplier
      }

      return String(firstValue || '').localeCompare(String(secondValue || ''), 'es', { sensitivity: 'base' }) * multiplier
    })

    return data
  }, [records, sortConfig])

  function scopeParams(companyId = activeCompanyId, vaultId = activeVaultId, includeVault = true) {
    const parts = []
    if (companyId) parts.push(`company_id=${encodeURIComponent(companyId)}`)
    if (includeVault && vaultId) parts.push(`vault_id=${encodeURIComponent(vaultId)}`)
    return parts.join('&')
  }

  function appendCompany(path, companyId = activeCompanyId, vaultId = activeVaultId, includeVault = true) {
    const query = scopeParams(companyId, vaultId, includeVault)
    if (!query) return path
    return `${path}${path.includes('?') ? '&' : '?'}${query}`
  }

  async function refreshCompanies() {
    const data = await api('/api/companies')
    setCompanies(data)
    return data
  }

  async function refreshCategoryOptions(companyId = activeCompanyId) {
    if (!companyId || !activeVaultId) {
      setCategories([])
      return
    }
    const data = await api(appendCompany('/api/data/categories', companyId))
    setCategories(data)
  }

  async function refreshSubcategoryOptions(categoryValue = '', companyId = activeCompanyId) {
    if (!companyId || !activeVaultId) {
      setSubcategories([])
      return
    }
    const query = categoryValue ? `?category=${encodeURIComponent(categoryValue)}` : ''
    const data = await api(appendCompany(`/api/data/subcategories${query}`, companyId))
    setSubcategories(data)
  }

  async function refreshProjectOptions(categoryValue = '', companyId = activeCompanyId) {
    if (!companyId || !activeVaultId) {
      setProjects([])
      return
    }
    const query = categoryValue ? `?category=${encodeURIComponent(categoryValue)}` : ''
    const data = await api(appendCompany(`/api/data/projects${query}`, companyId))
    setProjects(data)
  }

  async function refreshAccountOptions(companyId = activeCompanyId) {
    if (!companyId || !activeVaultId) {
      setAccounts([])
      return
    }
    const data = await api(appendCompany('/api/data/accounts', companyId))
    setAccounts(data)
  }

  async function refreshProjectCodeOptions(companyId = activeCompanyId) {
    if (!companyId || !activeVaultId) {
      setProjectCodes([])
      return
    }
    const data = await api(appendCompany('/api/data/project-codes', companyId))
    setProjectCodes(data)
  }

  async function refreshYears(companyId = activeCompanyId) {
    if (!companyId || !activeVaultId) {
      setYears([])
      return
    }
    const data = await api(appendCompany('/api/data/years', companyId))
    setYears(data)
  }

  async function refreshUploadsHistory(companyId = activeCompanyId) {
    if (!companyId || !activeVaultId) {
      setUploadsHistory([])
      return
    }
    const data = await api(appendCompany('/api/data/uploads', companyId))
    setUploadsHistory(data)
  }

  async function refreshVaults(companyId = activeCompanyId) {
    if (!companyId) {
      setVaults([])
      return []
    }
    const data = await api(appendCompany('/api/vaults', companyId, '', false))
    setVaults(data)
    return data
  }

  async function handleCreateCompany(event) {
    event.preventDefault()
    setCompanyMessage('')
    try {
      const formData = new FormData()
      formData.append('name', companyForm.name)
      formData.append('legal_name', companyForm.legal_name)
      formData.append('tax_id', companyForm.tax_id)
      formData.append('business_line', companyForm.business_line)

      const response = await fetch(
        withApiBase('/api/companies'),
        { credentials: 'include', ...withCsrfHeaders({ method: 'POST', body: formData }) },
      )
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'No se pudo crear la compañía')

      const companyList = await refreshCompanies()
      const createdId = String(payload.id)
      setActiveCompanyId(createdId)
      setActiveVaultId('')
      setFilters((prev) => ({ ...prev, companyId: createdId, vaultId: '' }))
      setCompanyForm({ name: '', legal_name: '', tax_id: '', business_line: '' })
      setCompanyMessage(`Compañía creada: ${payload.name}`)

      if (companyList.length > 0) {
        const vaultList = await refreshVaults(createdId)
        const selectedVaultId = vaultList.length === 1 ? String(vaultList[0].id) : ''
        setActiveVaultId(selectedVaultId)
        setFilters((prev) => ({ ...prev, companyId: createdId, vaultId: selectedVaultId }))
      }
    } catch (error) {
      setCompanyMessage(error.message)
    }
  }

  async function handleCreateVault(event) {
    event.preventDefault()
    setCompanyMessage('')
    try {
      const formData = new FormData()
      formData.append('name', vaultForm.name)
      formData.append('period_type', vaultForm.period_type)

      const response = await fetch(
        withApiBase(appendCompany('/api/vaults', activeCompanyId, '', false)),
        { credentials: 'include', ...withCsrfHeaders({ method: 'POST', body: formData }) },
      )
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'No se pudo crear el vault')

      const createdId = String(payload.id)
      await refreshVaults(activeCompanyId)
      setActiveVaultId(createdId)
      setFilters((prev) => ({ ...prev, companyId: activeCompanyId, vaultId: createdId }))
      setVaultForm({ name: '', period_type: 'custom' })
      setCompanyMessage(`Vault creado: ${payload.name}`)
    } catch (error) {
      setCompanyMessage(error.message)
    }
  }

  async function handleSelectCompany(nextCompanyId) {
    setCompanyMessage('')
    setActiveCompanyId(nextCompanyId)
    setActiveVaultId('')
    setFilters((prev) => ({ ...prev, companyId: nextCompanyId, vaultId: '' }))
    if (!nextCompanyId) {
      setVaults([])
      return
    }
    const vaultList = await refreshVaults(nextCompanyId)
    const selectedVaultId = vaultList.length === 1 ? String(vaultList[0].id) : ''
    setActiveVaultId(selectedVaultId)
    setFilters((prev) => ({ ...prev, companyId: nextCompanyId, vaultId: selectedVaultId }))
  }

  async function loadDashboard(customFilters = filters, page = 1, pageSize = pagination.page_size) {
    setLoading(true)
    setUploadMessage('')
    setUploadMessageType('info')
    try {
      const query = buildQuery(customFilters)
      const [recordsPage, newSummary, newReport, detailedRows] = await Promise.all([
        api(`/api/data/records-page?${query}&page=${page}&page_size=${pageSize}`),
        api(`/api/data/summary?${query}`),
        api(`/api/data/report?${query}`),
        api(`/api/data/records?${query}&limit=1000`),
      ])

      setRecords(recordsPage.items)
      setPagination({
        page: recordsPage.page,
        page_size: recordsPage.page_size,
        total: recordsPage.total,
        total_pages: recordsPage.total_pages,
      })
      setSummary(newSummary)
      setReport(newReport)
      setReportRows(detailedRows)
    } catch (error) {
      setUploadMessage(error.message)
      setUploadMessageType('error')
    } finally {
      setLoading(false)
    }
  }

  async function checkSession() {
    try {
      const me = await api('/api/me')
      setUser(me)
      const companyList = await refreshCompanies()
      const selectedCompanyId = companyList.length === 1 ? String(companyList[0].id) : ''
      setActiveCompanyId(selectedCompanyId)
      if (selectedCompanyId) {
        const vaultList = await refreshVaults(selectedCompanyId)
        const selectedVaultId = vaultList.length === 1 ? String(vaultList[0].id) : ''
        setActiveVaultId(selectedVaultId)
        setFilters((prev) => ({ ...prev, companyId: selectedCompanyId, vaultId: selectedVaultId }))
      } else {
        setActiveVaultId('')
        setFilters((prev) => ({ ...prev, companyId: '', vaultId: '' }))
      }
    } catch {
      setUser(null)
    }
  }

  useEffect(() => {
    const savedTheme = localStorage.getItem('datam-theme')
    if (savedTheme === 'light' || savedTheme === 'dark') {
      setTheme(savedTheme)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem('datam-theme', theme)
  }, [theme])

  useEffect(() => {
    checkSession()
  }, [])

  useEffect(() => {
    if (!fullScreenChart) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setFullScreenChart(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [fullScreenChart])

  async function handleRegister(event) {
    event.preventDefault()
    setAuthMessage('')
    setAuthLoading(true)

    try {
      const formData = new FormData()
      formData.append('full_name', registerForm.full_name)
      formData.append('username', registerForm.username)
      formData.append('password', registerForm.password)

      const response = await fetch(
        withApiBase('/api/auth/register'),
        { credentials: 'include', ...withCsrfHeaders({ method: 'POST', body: formData }) },
      )
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'No se pudo registrar')

      setAuthMessage('Usuario creado. Ahora puedes iniciar sesión.')
      setRegisterForm({ full_name: '', username: '', password: '' })
    } catch (error) {
      setAuthMessage(error.message)
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleLogin(event) {
    event.preventDefault()
    setAuthMessage('')
    setAuthLoading(true)

    try {
      const formData = new FormData()
      formData.append('username', loginForm.username)
      formData.append('password', loginForm.password)

      const response = await fetch(
        withApiBase('/api/auth/login'),
        { credentials: 'include', ...withCsrfHeaders({ method: 'POST', body: formData }) },
      )
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'No autenticado')

      const me = await api('/api/me')
      setUser(me)
      const companyList = await refreshCompanies()
      const selectedCompanyId = companyList.length === 1 ? String(companyList[0].id) : ''
      setActiveCompanyId(selectedCompanyId)
      if (selectedCompanyId) {
        const vaultList = await refreshVaults(selectedCompanyId)
        const selectedVaultId = vaultList.length === 1 ? String(vaultList[0].id) : ''
        setActiveVaultId(selectedVaultId)
        setFilters((prev) => ({ ...prev, companyId: selectedCompanyId, vaultId: selectedVaultId }))
      } else {
        setActiveVaultId('')
        setFilters((prev) => ({ ...prev, companyId: '', vaultId: '' }))
      }
    } catch (error) {
      setAuthMessage(error.message)
    } finally {
      setAuthLoading(false)
    }
  }

  async function handleLogout() {
    await fetch(withApiBase('/api/auth/logout'), { credentials: 'include', ...withCsrfHeaders({ method: 'POST' }) })
    setUser(null)
    setActiveCompanyId('')
    setActiveVaultId('')
    setVaults([])
    setRecords([])
    setSummary({ by_category: [], by_flow: [], by_month: [] })
    setReport({ totals: {}, top_categories: [], insights: [] })
    setReportRows([])
    setUploadMessage('')
    setUploadMessageType('info')
  }

  async function applyCategoryFilter(category) {
    const nextFilters = { ...filters, category: category || '', subcategory: '', project: '' }
    setFilters(nextFilters)
    await refreshSubcategoryOptions(category || '')
    await refreshProjectOptions(category || '')
    await loadDashboard(nextFilters, 1)
  }

  async function applyMonthFilter(monthLabel) {
    const nextFilters = {
      ...filters,
      month: monthLabel || '',
      dateExact: '',
      dateFrom: '',
      dateTo: '',
      year: '',
      monthNumber: '',
    }
    setFilters(nextFilters)
    await loadDashboard(nextFilters, 1)
  }

  async function clearChartFilters() {
    const nextFilters = {
      ...filters,
      flowType: '',
      category: '',
      subcategory: '',
      project: '',
      month: '',
      dateExact: '',
      dateFrom: '',
      dateTo: '',
      year: '',
      monthNumber: '',
    }
    setFilters(nextFilters)
    await refreshSubcategoryOptions('')
    await refreshProjectOptions('')
    await loadDashboard(nextFilters, 1)
  }

  async function handleUpload(event) {
    event.preventDefault()
    const file = event.target.file.files?.[0]
    if (!file) return

    setUploadMessage('')
    setUploadMessageType('info')
    setUploadLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      let response = await fetch(
        withApiBase(appendCompany('/api/data/upload?enforce_period_check=true')),
        { credentials: 'include', ...withCsrfHeaders({ method: 'POST', body: formData }) },
      )
      let payload = await response.json()

      if (response.status === 409) {
        const confirmed = window.confirm(payload.detail || 'Ya existe una carga para ese mes. ¿Deseas reemplazar solo ese mes y conservar los demás?')
        if (!confirmed) {
          throw new Error('Carga cancelada por el usuario')
        }
        response = await fetch(
          withApiBase(appendCompany('/api/data/upload?enforce_period_check=true&allow_period_update=true')),
          { credentials: 'include', ...withCsrfHeaders({ method: 'POST', body: formData }) },
        )
        payload = await response.json()
      }

      if (!response.ok) throw new Error(payload.detail || 'Error al subir archivo')

      const replacedRows = Number(payload.rows_replaced || 0)
      const replacedMessage = replacedRows > 0 ? ` · ${replacedRows} registros reemplazados del mes` : ''
      setUploadMessage(`${payload.message}: ${payload.rows_inserted} registros insertados${replacedMessage} · ${payload.duplicates_skipped || 0} duplicados omitidos`)
      setUploadMessageType('success')
      await refreshCategoryOptions()
      await refreshSubcategoryOptions(filters.category)
      await refreshProjectOptions(filters.category)
      await refreshAccountOptions()
      await refreshProjectCodeOptions()
      await refreshYears()
      await refreshUploadsHistory()
      await loadDashboard(filters, 1)
      event.target.reset()
      setSelectedUploadFile(null)
    } catch (error) {
      setUploadMessage(error.message)
      setUploadMessageType('error')
    } finally {
      setUploadLoading(false)
    }
  }

  async function applyFilters(event) {
    event.preventDefault()
    await loadDashboard(filters, 1)
  }

  async function clearFilters() {
    const clean = { companyId: filters.companyId, vaultId: filters.vaultId, search: '', category: '', subcategory: '', project: '', account: '', projectCode: '', year: '', monthNumber: '', flowType: '', month: '', dateExact: '', dateFrom: '', dateTo: '' }
    setFilters(clean)
    await refreshSubcategoryOptions('')
    await refreshProjectOptions('')
    await refreshAccountOptions()
    await refreshProjectCodeOptions()
    await refreshYears()
    await loadDashboard(clean, 1)
  }

  async function applyFlowFilter(flowType) {
    const nextFilters = { ...filters, flowType }
    setFilters(nextFilters)
    await loadDashboard(nextFilters, 1)
  }

  async function clearData() {
    const confirmed = window.confirm('¿Seguro que deseas eliminar los datos del filtro actual? Esta acción no se puede deshacer.')
    if (!confirmed) return

    try {
      const query = buildQuery(filters)
      const response = await fetch(
        withApiBase(`/api/data/clear?${query}`),
        { credentials: 'include', ...withCsrfHeaders({ method: 'DELETE' }) },
      )
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.detail || 'No se pudo limpiar los datos')

      setUploadMessage(`${payload.message}: ${payload.deleted_rows} registros eliminados`)
      setUploadMessageType('success')
      await refreshCategoryOptions()
      await refreshSubcategoryOptions(filters.category)
      await refreshProjectOptions(filters.category)
      await refreshAccountOptions()
      await refreshProjectCodeOptions()
      await refreshYears()
      await refreshUploadsHistory()
      await loadDashboard(filters, 1)
    } catch (error) {
      setUploadMessage(error.message)
      setUploadMessageType('error')
    }
  }

  useEffect(() => {
    if (!user || !activeCompanyId || !activeVaultId) return
    const nextFilters = { ...filters, companyId: activeCompanyId, vaultId: activeVaultId }
    setFilters(nextFilters)
    ;(async () => {
      await Promise.all([
        refreshCategoryOptions(activeCompanyId),
        refreshSubcategoryOptions('', activeCompanyId),
        refreshProjectOptions('', activeCompanyId),
        refreshAccountOptions(activeCompanyId),
        refreshProjectCodeOptions(activeCompanyId),
        refreshYears(activeCompanyId),
        refreshUploadsHistory(activeCompanyId),
      ])
      await loadDashboard(nextFilters, 1)
    })()
  }, [activeCompanyId, activeVaultId])

  async function changePage(nextPage) {
    if (nextPage < 1 || nextPage > pagination.total_pages || nextPage === pagination.page) return
    await loadDashboard(filters, nextPage)
  }

  async function changePageSize(nextPageSize) {
    setPagination((prev) => ({ ...prev, page_size: nextPageSize, page: 1 }))
    await loadDashboard(filters, 1, nextPageSize)
  }

  async function exportFilteredRecordsCsv() {
    try {
      const query = buildQuery(filters)
      const rows = await api(`/api/data/records?${query}&limit=1000`)
      const csv = rowsToCsv(
        ['mes', 'fecha', 'cuenta', 'categoria', 'subcategoria', 'proyecto', 'codigo_proyecto', 'emisor_receptor', 'descripcion', 'tipo_documento', 'numero_documento', 'tipo', 'verificado', 'comentarios', 'monto', 'saldo'],
        rows.map((item) => [
          item.mes,
          item.fecha,
          item.cuenta,
          item.categoria,
          item.subcategoria,
          item.proyecto,
          item.codigo_proyecto,
          item.emisor_receptor,
          item.descripcion,
          item.tipo_documento,
          item.numero_documento,
          item.tipo,
          item.verificado,
          item.comentarios,
          item.monto,
          item.saldo,
        ])
      )
      downloadCsv(`registros_filtrados_${new Date().toISOString().slice(0, 10)}.csv`, csv)
    } catch (error) {
      setUploadMessage(error.message)
      setUploadMessageType('error')
    }
  }

  function exportReportCsv() {
    const summaryRows = [
      ['metric', 'value'],
      ['income', report?.totals?.income ?? 0],
      ['expense', report?.totals?.expense ?? 0],
      ['balance', report?.totals?.balance ?? 0],
      ['records', report?.totals?.records ?? 0],
      [],
      ['top_category', 'amount'],
      ...(report?.top_categories || []).map((item) => [item.label, item.value]),
      [],
      ['insight', 'detail'],
      ...(report?.insights || []).map((insight, index) => [`insight_${index + 1}`, insight]),
    ]

    const detailRows = [
      [],
      ['detalle_registros_filtrados'],
      ['mes', 'fecha', 'cuenta', 'categoria', 'subcategoria', 'proyecto', 'codigo_proyecto', 'tipo', 'monto', 'saldo', 'descripcion'],
      ...reportRows.map((item) => [
        item.mes,
        item.fecha,
        item.cuenta,
        item.categoria,
        item.subcategoria,
        item.proyecto,
        item.codigo_proyecto,
        item.tipo,
        item.monto,
        item.saldo,
        item.descripcion,
      ]),
    ]

    const csv = [...summaryRows, ...detailRows].map((row) => row.map((cell) => escapeCsvValue(cell)).join(',')).join('\n')
    downloadCsv(`informe_detallado_${new Date().toISOString().slice(0, 10)}.csv`, csv)
  }

  async function exportReportPdf() {
    try {
      const doc = new jsPDF({ unit: 'pt', format: 'a4' })
      const now = new Date().toLocaleString('es-CL')
      const selectedCompany = companies.find((item) => String(item.id) === String(activeCompanyId))
      const selectedVault = vaults.find((item) => String(item.id) === String(activeVaultId))
      const detailRows = reportRows.slice(0, 200)
      const income = Number(report?.totals?.income || 0)
      const expense = Number(report?.totals?.expense || 0)
      const balance = Number(report?.totals?.balance || 0)
      const recordsCount = Number(report?.totals?.records || 0)
      const expenseRatio = income > 0 ? (expense / income) * 100 : 0
      const recommendations = []
      if (balance < 0) recommendations.push('Priorizar reducción de egresos de mayor impacto y revisar categorías con desvíos.')
      if (income > 0 && expenseRatio > 90) recommendations.push('La presión de caja es alta (>90% de egreso sobre ingreso); ajustar presupuesto operativo.')
      if (recordsCount < 20) recommendations.push('Muestra con pocos registros; considerar ampliar periodo o consolidar más cargas para mayor precisión.')
      if (recommendations.length === 0) recommendations.push('El periodo muestra estabilidad; mantener seguimiento mensual y alertas tempranas por categoría.')

      doc.setFillColor(15, 23, 42)
      doc.rect(0, 0, 595, 842, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(24)
      doc.text('DataM', 40, 72)
      doc.setFontSize(18)
      doc.text('Informe Ejecutivo Financiero', 40, 102)
      doc.setFontSize(10)
      doc.text(`Generado: ${now}`, 40, 124)
      doc.text(`Usuario: ${user?.full_name || '-'}`, 40, 140)
      doc.text(`Compañía: ${selectedCompany?.name || '-'}`, 40, 156)
      doc.text(`Vault: ${selectedVault ? `${selectedVault.name} (${selectedVault.period_type})` : '-'}`, 40, 172)

      doc.setFillColor(30, 41, 59)
      doc.roundedRect(40, 196, 515, 120, 8, 8, 'F')
      doc.setFontSize(11)
      doc.text('Resumen ejecutivo', 54, 220)
      doc.setFontSize(10)
      doc.text(`Periodo aplicado: ${currentPeriod}`, 54, 240)
      doc.text(`Ingresos: ${currency(income)}`, 54, 258)
      doc.text(`Egresos: ${currency(expense)}`, 54, 276)
      doc.text(`Balance: ${currency(balance)}`, 280, 258)
      doc.text(`Registros analizados: ${recordsCount}`, 280, 276)
      doc.text(`Relación egreso/ingreso: ${expenseRatio.toFixed(1)}%`, 280, 294)

      doc.setTextColor(15, 23, 42)
      autoTable(doc, {
        startY: 340,
        head: [['Recomendaciones clave para gestión']],
        body: recommendations.map((item) => [item]),
        theme: 'grid',
        styles: { fontSize: 10, textColor: [15, 23, 42] },
        headStyles: { fillColor: [37, 99, 235] },
        columnStyles: { 0: { cellWidth: 510 } },
      })

      doc.setFontSize(9)
      doc.setTextColor(100, 116, 139)
      doc.text('Las páginas siguientes contienen el detalle completo de métricas, gráficos y movimientos filtrados.', 40, 800)

      doc.addPage()

      doc.setFillColor(37, 99, 235)
      doc.rect(0, 0, 595, 86, 'F')
      doc.setTextColor(255, 255, 255)
      doc.setFontSize(19)
      doc.text('DataM - Informe Detallado de Flujos', 40, 42)
      doc.setFontSize(10)
      doc.text(`Generado: ${now}`, 40, 60)
      doc.text(`Usuario: ${user?.full_name || '-'}`, 40, 75)

      doc.setTextColor(15, 23, 42)

      autoTable(doc, {
        startY: 104,
        head: [['Contexto del informe', 'Valor']],
        body: [
          ['Compañía', selectedCompany?.name || '-'],
          ['Vault', selectedVault ? `${selectedVault.name} (${selectedVault.period_type})` : '-'],
          ['Periodo aplicado', currentPeriod],
          ['Flujo', filters.flowType || 'Todos'],
          ['Categoría', filters.category || 'Todas'],
          ['Subcategoría', filters.subcategory || 'Todas'],
          ['Proyecto', filters.project || 'Todos'],
          ['Cuenta', filters.account || 'Todas'],
          ['Código proyecto', filters.projectCode || 'Todos'],
          ['Rango de fechas', `${filters.dateFrom || '-'} a ${filters.dateTo || '-'}`],
        ],
        theme: 'grid',
        styles: { fontSize: 8.5 },
        headStyles: { fillColor: [15, 23, 42] },
      })

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 12,
        head: [['Métrica', 'Valor']],
        body: [
          ['Ingresos', currency(report?.totals?.income ?? 0)],
          ['Egresos', currency(report?.totals?.expense ?? 0)],
          ['Balance', currency(report?.totals?.balance ?? 0)],
          ['Registros', String(report?.totals?.records ?? 0)],
        ],
        theme: 'grid',
        styles: { fontSize: 9 },
        headStyles: { fillColor: [37, 99, 235] },
      })

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 12,
        head: [['Resumen por flujo', 'Monto']],
        body: (report?.by_flow || []).map((item) => [item.label, currency(item.value)]),
        theme: 'striped',
        styles: { fontSize: 9 },
      })

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 14,
        head: [['Top categorías', 'Monto']],
        body: (report?.top_categories || []).map((item) => [item.label, currency(item.value)]),
        theme: 'striped',
        styles: { fontSize: 9 },
      })

      autoTable(doc, {
        startY: doc.lastAutoTable.finalY + 14,
        head: [['Insights automáticos']],
        body: (report?.insights || []).map((insight) => [insight]),
        theme: 'plain',
        styles: { fontSize: 9 },
        columnStyles: { 0: { cellWidth: 510 } },
      })

      const chartRefs = [
        { label: 'Categorías', ref: categoryChartRef },
        { label: 'Ingreso / Egreso', ref: flowChartRef },
        { label: 'Tendencia', ref: monthChartRef },
      ]

      let currentY = doc.lastAutoTable.finalY + 16
      const chartWidth = 170
      const chartHeight = 110
      let chartX = 40

      for (const chart of chartRefs) {
        const node = chart.ref.current
        if (!node) continue
        try {
          const canvas = await html2canvas(node, {
            backgroundColor: '#ffffff',
            scale: 1.4,
            useCORS: true,
          })
          const imageData = canvas.toDataURL('image/png')
          doc.setFontSize(9)
          doc.text(chart.label, chartX, currentY)
          doc.addImage(imageData, 'PNG', chartX, currentY + 6, chartWidth, chartHeight)
          chartX += chartWidth + 16
        } catch {
          doc.setFontSize(9)
          doc.text(`${chart.label}: no disponible para captura`, chartX, currentY + 20)
          chartX += chartWidth + 16
        }
      }

      currentY += chartHeight + 28
      if (currentY > 720) {
        doc.addPage()
        currentY = 42
      }

      autoTable(doc, {
        startY: currentY,
        head: [['Mes', 'Fecha', 'Tipo', 'Categoría', 'Subcategoría', 'Cuenta', 'Proyecto', 'Doc', 'Monto', 'Saldo', 'Descripción']],
        body: detailRows.map((item) => [
          item.mes,
          item.fecha,
          item.tipo,
          item.categoria,
          item.subcategoria,
          item.cuenta,
          item.proyecto,
          `${item.tipo_documento || '-'} ${item.numero_documento || ''}`.trim(),
          currency(item.monto),
          currency(item.saldo),
          item.descripcion || '-',
        ]),
        theme: 'grid',
        styles: { fontSize: 7.5, cellPadding: 3 },
        headStyles: { fillColor: [37, 99, 235] },
        columnStyles: {
          0: { cellWidth: 42 },
          1: { cellWidth: 52 },
          2: { cellWidth: 38 },
          3: { cellWidth: 56 },
          4: { cellWidth: 58 },
          5: { cellWidth: 48 },
          6: { cellWidth: 55 },
          7: { cellWidth: 62 },
          8: { cellWidth: 52, halign: 'right' },
          9: { cellWidth: 52, halign: 'right' },
          10: { cellWidth: 90 },
        },
      })

      const detailEndY = doc.lastAutoTable.finalY + 14
      const pendingCount = Math.max(reportRows.length - detailRows.length, 0)
      doc.setFontSize(8.5)
      doc.setTextColor(71, 85, 105)
      const footerLines = [
        `Detalle mostrado: ${detailRows.length} de ${reportRows.length} movimientos filtrados.`,
        pendingCount > 0 ? `Movimientos restantes no incluidos en PDF: ${pendingCount}.` : 'Se incluyeron todos los movimientos filtrados.',
        'Interpretación: valores positivos/negativos se explican por el tipo de flujo (ingreso/egreso) y el periodo aplicado en filtros.',
      ]
      doc.text(footerLines, 40, Math.min(detailEndY, 810))

      doc.save(`informe_ejecutivo_${new Date().toISOString().slice(0, 10)}.pdf`)
    } catch (error) {
      setUploadMessage(error instanceof Error ? error.message : 'No se pudo generar el PDF')
      setUploadMessageType('error')
    }
  }

  if (!user) {
    return (
      <div className={`relative min-h-screen overflow-hidden ${isDark ? 'bg-slate-950 text-slate-100' : 'bg-slate-100 text-slate-900'}`}>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,#1d4ed855,transparent_35%),radial-gradient(circle_at_left,#0ea5e933,transparent_35%)]" />

        <div className="absolute right-6 top-6 z-20">
          <Button className={ghostButtonToneClass} variant="ghost" type="button" onClick={() => setTheme(isDark ? 'light' : 'dark')}>
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} {isDark ? 'Light' : 'Dark'}
          </Button>
        </div>

        <div className="relative mx-auto grid min-h-screen max-w-6xl grid-cols-1 items-center gap-8 px-6 py-12 lg:grid-cols-2">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }} className="hidden pr-8 lg:block">
            <Badge>DataM Finance Suite</Badge>
            <h1 className="mt-5 text-5xl font-semibold leading-tight tracking-tight">Presentación contable con impacto visual real</h1>
            <p className={`mt-4 max-w-xl ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
              Frontend renovado, autenticación segura y visualización dinámica de flujos financieros para decisiones rápidas.
            </p>
          </motion.div>

          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, delay: 0.08 }}>
            <Card className={`${cardToneClass} rounded-3xl p-6`}>
              <CardHeader>
                <CardTitle className={`text-2xl ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Acceso a plataforma</CardTitle>
                <CardDescription>{authMode === 'login' ? 'Inicia sesión para entrar al dashboard.' : 'Crea tu cuenta para comenzar.'}</CardDescription>
              </CardHeader>

              <CardContent>
                {authMode === 'login' ? (
                  <form className="space-y-3" onSubmit={handleLogin}>
                    <Input className={inputToneClass} placeholder="Usuario" value={loginForm.username} onChange={(event) => setLoginForm((prev) => ({ ...prev, username: event.target.value }))} required />
                    <Input className={inputToneClass} type="password" placeholder="Contraseña" minLength={10} value={loginForm.password} onChange={(event) => setLoginForm((prev) => ({ ...prev, password: event.target.value }))} required />
                    <Button className="w-full" disabled={authLoading} type="submit">{authLoading ? 'Ingresando...' : 'Ingresar'}</Button>
                  </form>
                ) : (
                  <form className="space-y-3" onSubmit={handleRegister}>
                    <Input className={inputToneClass} placeholder="Nombre completo" value={registerForm.full_name} onChange={(event) => setRegisterForm((prev) => ({ ...prev, full_name: event.target.value }))} required />
                    <Input className={inputToneClass} placeholder="Nuevo usuario" value={registerForm.username} onChange={(event) => setRegisterForm((prev) => ({ ...prev, username: event.target.value }))} required />
                    <Input className={inputToneClass} type="password" minLength={10} placeholder="Nueva contraseña" value={registerForm.password} onChange={(event) => setRegisterForm((prev) => ({ ...prev, password: event.target.value }))} required />
                    <Button className={`w-full ${secondaryButtonToneClass}`} variant="secondary" disabled={authLoading} type="submit">{authLoading ? 'Creando...' : 'Crear usuario'}</Button>
                  </form>
                )}

                <div className="mt-4 text-center text-sm">
                  {authMode === 'login' ? (
                    <button
                      className="text-blue-500 hover:text-blue-400"
                      type="button"
                      onClick={() => {
                        setAuthMessage('')
                        setAuthMode('register')
                      }}
                    >
                      ¿No tienes cuenta? Crear usuario
                    </button>
                  ) : (
                    <button
                      className="text-blue-500 hover:text-blue-400"
                      type="button"
                      onClick={() => {
                        setAuthMessage('')
                        setAuthMode('login')
                      }}
                    >
                      ¿Ya tienes cuenta? Iniciar sesión
                    </button>
                  )}
                </div>

                {authMessage ? <p className="mt-4 text-sm text-blue-500">{authMessage}</p> : null}
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>
    )
  }

  if (!activeCompanyId) {
    return (
      <div className={`min-h-screen ${sectionBgClass}`}>
        <div className="mx-auto max-w-3xl px-5 py-10">
          <Card className={cardToneClass}>
            <CardHeader>
              <CardTitle>Selecciona una compañía</CardTitle>
              <CardDescription>Elige qué empresa deseas analizar o crea una nueva para iniciar su dashboard.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Compañías disponibles</p>
                <select className={selectClass} value={activeCompanyId} onChange={(event) => { handleSelectCompany(event.target.value) }}>
                  <option value="">Selecciona una compañía</option>
                  {companies.map((company) => <option key={company.id} value={String(company.id)}>{company.name}</option>)}
                </select>
              </div>

              <div className={`my-4 h-px ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />

              <form className="grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={handleCreateCompany}>
                <Input className={inputToneClass} placeholder="Nombre dashboard compañía" value={companyForm.name} onChange={(event) => setCompanyForm((prev) => ({ ...prev, name: event.target.value }))} required />
                <Input className={inputToneClass} placeholder="Razón social" value={companyForm.legal_name} onChange={(event) => setCompanyForm((prev) => ({ ...prev, legal_name: event.target.value }))} />
                <Input className={inputToneClass} placeholder="RUT / ID fiscal" value={companyForm.tax_id} onChange={(event) => setCompanyForm((prev) => ({ ...prev, tax_id: event.target.value }))} />
                <Input className={inputToneClass} placeholder="Giro / Rubro" value={companyForm.business_line} onChange={(event) => setCompanyForm((prev) => ({ ...prev, business_line: event.target.value }))} />
                <div className="md:col-span-2 flex flex-wrap gap-2">
                  <Button type="submit">Crear compañía</Button>
                  <Button className={ghostButtonToneClass} variant="ghost" type="button" onClick={handleLogout}>Cerrar sesión</Button>
                </div>
              </form>

              {companyMessage ? <p className="mt-3 text-sm text-blue-500">{companyMessage}</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  if (!activeVaultId) {
    return (
      <div className={`min-h-screen ${sectionBgClass}`}>
        <div className="mx-auto max-w-3xl px-5 py-10">
          <Card className={cardToneClass}>
            <CardHeader>
              <CardTitle>Selecciona un vault</CardTitle>
              <CardDescription>
                Crea un contenedor independiente para tus datos (mensual, trimestral, anual o personalizado).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-4">
                <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Vaults disponibles</p>
                <select className={selectClass} value={activeVaultId} onChange={(event) => {
                  const nextVaultId = event.target.value
                  setActiveVaultId(nextVaultId)
                  setFilters((prev) => ({ ...prev, vaultId: nextVaultId }))
                }}>
                  <option value="">Selecciona un vault</option>
                  {vaults.map((vault) => <option key={vault.id} value={String(vault.id)}>{vault.name} · {vault.period_type}</option>)}
                </select>
              </div>

              <div className={`my-4 h-px ${isDark ? 'bg-slate-800' : 'bg-slate-200'}`} />

              <form className="grid grid-cols-1 gap-3 md:grid-cols-2" onSubmit={handleCreateVault}>
                <Input className={inputToneClass} placeholder="Nombre del vault (ej: Enero 2026, Q1 2026, Anual 2025)" value={vaultForm.name} onChange={(event) => setVaultForm((prev) => ({ ...prev, name: event.target.value }))} required />
                <select className={selectClass} value={vaultForm.period_type} onChange={(event) => setVaultForm((prev) => ({ ...prev, period_type: event.target.value }))}>
                  <option value="mensual">Mensual</option>
                  <option value="trimestral">Trimestral</option>
                  <option value="anual">Anual</option>
                  <option value="custom">Personalizado</option>
                </select>
                <div className="md:col-span-2 flex flex-wrap gap-2">
                  <Button type="submit">Crear vault</Button>
                  <Button className={ghostButtonToneClass} variant="ghost" type="button" onClick={() => setActiveCompanyId('')}>Cambiar compañía</Button>
                </div>
              </form>

              {companyMessage ? <p className="mt-3 text-sm text-blue-500">{companyMessage}</p> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  return (
    <div className={`min-h-screen ${sectionBgClass}`}>
      <div className="mx-auto max-w-7xl px-5 py-8">
        <motion.header initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={`${isDark ? 'text-slate-400' : 'text-slate-600'} text-sm`}>Bienvenido</p>
            <h1 className="text-2xl font-semibold">{user.full_name}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[220px]">
              <select
                className={selectClass}
                value={activeCompanyId}
                onChange={(event) => {
                  handleSelectCompany(event.target.value)
                }}
              >
                <option value="">Selecciona compañía</option>
                {companies.map((company) => <option key={company.id} value={String(company.id)}>{company.name}</option>)}
              </select>
            </div>
            <div className="min-w-[220px]">
              <select
                className={selectClass}
                value={activeVaultId}
                onChange={(event) => {
                  const nextVaultId = event.target.value
                  setActiveVaultId(nextVaultId)
                  setFilters((prev) => ({ ...prev, vaultId: nextVaultId }))
                }}
              >
                <option value="">Selecciona vault</option>
                {vaults.map((vault) => <option key={vault.id} value={String(vault.id)}>{vault.name} · {vault.period_type}</option>)}
              </select>
            </div>
            <Button className={ghostButtonToneClass} variant="ghost" type="button" onClick={() => setTheme(isDark ? 'light' : 'dark')}>
              {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} {isDark ? 'Light' : 'Dark'}
            </Button>
            <Button className={ghostButtonToneClass} variant="ghost" onClick={handleLogout} type="button"><LogOut className="h-4 w-4" /> Cerrar sesión</Button>
          </div>
        </motion.header>

        <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-4">
          <KpiCard label="Ingresos" value={currency(kpis.income)} colorClass="text-emerald-500" isDark={isDark} />
          <KpiCard label="Egresos" value={currency(kpis.expense)} colorClass="text-rose-500" isDark={isDark} />
          <KpiCard label="Balance" value={currency(kpis.balance)} colorClass="text-blue-500" isDark={isDark} />
          <KpiCard label="Movimientos" value={kpis.operations} isDark={isDark} />
        </section>

        <section className="mb-6">
          <div className={`inline-flex w-full flex-wrap gap-2 rounded-2xl border p-2 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-white shadow-sm'}`}>
            {[
              { id: 'home', label: 'Inicio' },
              { id: 'upload', label: 'Carga Excel' },
              { id: 'records', label: 'Registros y filtros' },
              { id: 'charts', label: 'Gráficos' },
              { id: 'report', label: 'Informe detallado' },
            ].map((tab) => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
                    isActive
                      ? 'bg-blue-600 text-white'
                      : isDark
                        ? 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                        : 'bg-slate-100 text-slate-700 hover:bg-blue-50'
                  }`}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
        </section>

        {activeTab === 'home' && (
          <section className="mb-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
            <Card className={`xl:col-span-2 ${cardToneClass}`}>
              <CardHeader>
                <CardTitle>Resumen ejecutivo</CardTitle>
                <CardDescription>Vista general de tu estado financiero actual y desempeño.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Ingresos</p>
                    <p className="mt-2 text-lg font-semibold text-emerald-500">{currency(kpis.income)}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Egresos</p>
                    <p className="mt-2 text-lg font-semibold text-rose-500">{currency(kpis.expense)}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Balance</p>
                    <p className="mt-2 text-lg font-semibold text-blue-500">{currency(kpis.balance)}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Movimientos</p>
                    <p className="mt-2 text-lg font-semibold">{kpis.operations}</p>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-white'}`}>
                    <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Top categorías</p>
                    <ul className="space-y-2 text-sm">
                      {(report.top_categories || []).slice(0, 5).map((item) => (
                        <li key={item.label} className="flex items-center justify-between">
                          <span>{item.label}</span>
                          <span className="font-semibold">{currency(item.value)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-950/40' : 'border-slate-200 bg-white'}`}>
                    <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Insights clave</p>
                    <ul className="space-y-2 text-sm">
                      {(report.insights || []).slice(0, 4).map((insight) => (
                        <li key={insight} className={`rounded-lg border px-3 py-2 ${isDark ? 'border-slate-700 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                          {insight}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className={cardToneClass}>
              <CardHeader>
                <CardTitle>Últimos movimientos</CardTitle>
                <CardDescription>Registros recientes para una lectura rápida.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {sortedRecords.slice(0, 6).map((item) => (
                    <li key={`home-${item.id}`} className={`rounded-lg border px-3 py-2 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{item.categoria}</span>
                        <span className={item.tipo === 'ingreso' ? 'font-semibold text-emerald-500' : 'font-semibold text-rose-500'}>{currency(item.monto)}</span>
                      </div>
                      <p className={`mt-1 truncate text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>{item.fecha} · {item.subcategoria}</p>
                    </li>
                  ))}
                  {sortedRecords.length === 0 && (
                    <li className={`rounded-lg border px-3 py-4 text-center text-sm ${isDark ? 'border-slate-800 bg-slate-900/60 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                      No hay registros para mostrar.
                    </li>
                  )}
                </ul>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={() => setActiveTab('records')}>
                    Ver registros
                  </Button>
                  <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={() => setActiveTab('charts')}>
                    Ver gráficos
                  </Button>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {activeTab === 'upload' && (
          <section className="mb-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
            <Card className={`xl:col-span-2 ${cardToneClass}`}>
              <CardHeader>
                <CardTitle>Carga de Excel</CardTitle>
                <CardDescription>Sube archivo mensual y conserva historial para trazabilidad.</CardDescription>
              </CardHeader>
              <CardContent>
                <form className="grid gap-3" onSubmit={handleUpload}>
                  <div className={`rounded-2xl border border-dashed p-4 ${isDark ? 'border-slate-700 bg-slate-900/50' : 'border-slate-300 bg-slate-50'}`}>
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className={`text-sm font-medium ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Archivo contable mensual</p>
                        <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Formatos permitidos: .xlsx y .xls</p>
                      </div>
                      <Input
                        className={inputToneClass}
                        name="file"
                        type="file"
                        accept=".xlsx,.xls"
                        required
                        onChange={(event) => {
                          const file = event.target.files?.[0] || null
                          setSelectedUploadFile(file)
                        }}
                      />
                    </div>

                    <div className={`mt-3 grid gap-2 rounded-xl border p-3 text-xs ${isDark ? 'border-slate-700 bg-slate-950/60 text-slate-300' : 'border-slate-200 bg-white text-slate-600'}`}>
                      <p className="font-medium">Mantenibilidad de cargas</p>
                      <p>• La app guarda copia del Excel cargado para trazabilidad.</p>
                      <p>• Si subes el mismo registro de nuevo, se omite como duplicado.</p>
                      <p>• Los datos anteriores no se pierden al sumar nuevos meses.</p>
                    </div>

                    {selectedUploadFile ? (
                      <div className={`mt-3 rounded-xl border px-3 py-2 text-sm ${isDark ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700'}`}>
                        Seleccionado: {selectedUploadFile.name} · {formatFileSize(selectedUploadFile.size)}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Button className="flex items-center gap-2" type="submit" disabled={uploadLoading}>
                      <Upload className="h-4 w-4" /> {uploadLoading ? 'Subiendo...' : 'Subir archivo'}
                    </Button>

                    <Button className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100 hover:border-rose-300" type="button" variant="secondary" onClick={clearData}>
                      <Trash2 className="h-4 w-4" /> Limpiar datos
                    </Button>
                  </div>
                </form>

                {uploadMessage ? (
                  <p className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
                    uploadMessageType === 'success'
                      ? (isDark ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-700')
                      : uploadMessageType === 'error'
                        ? (isDark ? 'border-rose-900/60 bg-rose-950/30 text-rose-300' : 'border-rose-200 bg-rose-50 text-rose-700')
                        : (isDark ? 'border-blue-900/60 bg-blue-950/30 text-blue-300' : 'border-blue-200 bg-blue-50 text-blue-700')
                  }`}
                >
                  {uploadMessage}
                </p>
                ) : null}
              </CardContent>
            </Card>

            <Card className={cardToneClass}>
              <CardHeader>
                <CardTitle>Historial de cargas</CardTitle>
                <CardDescription>Últimos archivos procesados.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {uploadsHistory.slice(0, 8).map((item) => (
                    <li key={item.id} className={`rounded-lg border px-3 py-2 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                      <p className="truncate font-medium" title={item.filename}>{item.filename}</p>
                      <p className={`mt-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
                        Periodo: {item.period || '-'} · +{item.rows_inserted} / dup {item.duplicates_skipped}
                      </p>
                    </li>
                  ))}
                  {uploadsHistory.length === 0 && (
                    <li className={`rounded-lg border px-3 py-4 text-center text-sm ${isDark ? 'border-slate-800 bg-slate-900/60 text-slate-400' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                      Aún no hay cargas registradas.
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>
          </section>
        )}

        {activeTab === 'records' && (
          <>
            <Card className={`mb-6 ${cardToneClass}`}>
              <CardHeader>
                <CardTitle>Filtros dinámicos</CardTitle>
                <CardDescription>Filtra por categoría, fechas y diferencia visualmente ingresos/egresos.</CardDescription>
              </CardHeader>
              <CardContent>
                <form className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6" onSubmit={applyFilters}>
                  <div className="xl:col-span-2">
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Buscar</p>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-500" />
                      <Input className={`pl-9 ${inputToneClass}`} placeholder="Buscar por descripción" value={filters.search} onChange={(event) => setFilters((prev) => ({ ...prev, search: event.target.value }))} />
                    </div>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Categoría</p>
                    <select className={selectClass} value={filters.category} onChange={async (event) => {
                      const category = event.target.value
                      setFilters((prev) => ({ ...prev, category, subcategory: '', project: '' }))
                      await refreshSubcategoryOptions(category)
                      await refreshProjectOptions(category)
                    }}>
                      <option value="">Todas las categorías</option>
                      {categories.map((category) => <option key={category} value={category}>{category}</option>)}
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Subcategoría</p>
                    <select className={selectClass} value={filters.subcategory} onChange={(event) => setFilters((prev) => ({ ...prev, subcategory: event.target.value }))}>
                      <option value="">Todas las subcategorías</option>
                      {subcategories.map((subcategory) => <option key={subcategory} value={subcategory}>{subcategory}</option>)}
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Proyecto</p>
                    <select className={selectClass} value={filters.project} onChange={(event) => setFilters((prev) => ({ ...prev, project: event.target.value }))}>
                      <option value="">Todos los proyectos</option>
                      {projects.map((project) => <option key={project} value={project}>{project}</option>)}
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Cuenta</p>
                    <select className={selectClass} value={filters.account} onChange={(event) => setFilters((prev) => ({ ...prev, account: event.target.value }))}>
                      <option value="">Todas las cuentas</option>
                      {accounts.map((account) => <option key={account} value={account}>{account}</option>)}
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Código proyecto</p>
                    <select className={selectClass} value={filters.projectCode} onChange={(event) => setFilters((prev) => ({ ...prev, projectCode: event.target.value }))}>
                      <option value="">Todos los códigos</option>
                      {projectCodes.map((projectCode) => <option key={projectCode} value={projectCode}>{projectCode}</option>)}
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Año</p>
                    <select className={selectClass} value={filters.year} onChange={(event) => setFilters((prev) => ({ ...prev, year: event.target.value }))}>
                      <option value="">Todos los años</option>
                      {years.map((year) => <option key={year} value={year}>{year}</option>)}
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Mes (número)</p>
                    <select className={selectClass} value={filters.monthNumber} onChange={(event) => setFilters((prev) => ({ ...prev, monthNumber: event.target.value }))}>
                      <option value="">Todos los meses</option>
                      {Array.from({ length: 12 }).map((_, index) => {
                        const monthValue = String(index + 1)
                        const monthLabel = String(index + 1).padStart(2, '0')
                        return <option key={monthValue} value={monthValue}>{monthLabel}</option>
                      })}
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Tipo de flujo</p>
                    <select className={selectClass} value={filters.flowType} onChange={(event) => setFilters((prev) => ({ ...prev, flowType: event.target.value }))}>
                      <option value="">Todos</option>
                      <option value="ingreso">Ingreso</option>
                      <option value="egreso">Egreso</option>
                    </select>
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Mes</p>
                    <Input className={inputToneClass} type="month" value={filters.month} onChange={(event) => setFilters((prev) => ({ ...prev, month: event.target.value, dateExact: '' }))} />
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Fecha exacta</p>
                    <Input className={inputToneClass} type="date" value={filters.dateExact} onChange={(event) => setFilters((prev) => ({ ...prev, dateExact: event.target.value, month: '' }))} />
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Desde</p>
                    <Input className={inputToneClass} type="date" value={filters.dateFrom} onChange={(event) => setFilters((prev) => ({ ...prev, dateFrom: event.target.value }))} />
                  </div>

                  <div>
                    <p className={`mb-1 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Hasta</p>
                    <Input className={inputToneClass} type="date" value={filters.dateTo} onChange={(event) => setFilters((prev) => ({ ...prev, dateTo: event.target.value }))} />
                  </div>

                  <div className="xl:col-span-6 flex flex-wrap items-end gap-2">
                    <Button type="submit" disabled={loading}>Aplicar</Button>
                    <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={clearFilters}>Limpiar</Button>
                  </div>
                </form>
              </CardContent>
            </Card>

            <Card className={`mb-6 ${cardToneClass}`}>
              <CardHeader><CardTitle>Registros</CardTitle></CardHeader>
              <CardContent>
                <div className={`mb-4 rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/60' : 'border-slate-200 bg-slate-50'}`}>
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_220px_220px_auto] xl:items-end">
                    <div>
                      <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Campos visibles</p>
                      <div className="flex flex-wrap gap-2">
                        {[
                          { key: 'posicion', label: 'Posición' },
                          { key: 'mes', label: 'Mes' },
                          { key: 'fecha', label: 'Fecha' },
                          { key: 'cuenta', label: 'Cuenta' },
                          { key: 'categoria', label: 'Categoría' },
                          { key: 'subcategoria', label: 'Subcategoría' },
                          { key: 'proyecto', label: 'Proyecto' },
                          { key: 'codigo_proyecto', label: 'Código proyecto' },
                          { key: 'emisor_receptor', label: 'Emisor/Receptor' },
                          { key: 'descripcion', label: 'Descripción' },
                          { key: 'tipo_documento', label: 'Tipo documento' },
                          { key: 'numero_documento', label: 'N° documento' },
                          { key: 'tipo', label: 'Tipo' },
                          { key: 'verificado', label: 'Verificado' },
                          { key: 'comentarios', label: 'Comentarios' },
                          { key: 'monto', label: 'Monto' },
                          { key: 'saldo', label: 'Saldo' },
                          { key: 'archivo_origen', label: 'Archivo origen' },
                        ].map((column) => (
                          <label
                            key={column.key}
                            className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${isDark ? 'border-slate-700 bg-slate-950/60 text-slate-200' : 'border-slate-300 bg-white text-slate-700'}`}
                          >
                            <input
                              checked={visibleColumns[column.key]}
                              type="checkbox"
                              onChange={(event) => {
                                const enabled = event.target.checked
                                setVisibleColumns((prev) => ({ ...prev, [column.key]: enabled }))
                              }}
                            />
                            {column.label}
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Ordenar por</p>
                      <select className={selectClass} value={sortConfig.field} onChange={(event) => setSortConfig((prev) => ({ ...prev, field: event.target.value }))}>
                        <option value="fecha">Fecha</option>
                        <option value="mes">Mes (A-Z)</option>
                        <option value="cuenta">Cuenta (A-Z)</option>
                        <option value="categoria">Categoría (A-Z)</option>
                        <option value="subcategoria">Subcategoría (A-Z)</option>
                        <option value="proyecto">Proyecto (A-Z)</option>
                        <option value="codigo_proyecto">Código proyecto (A-Z)</option>
                        <option value="emisor_receptor">Emisor/Receptor (A-Z)</option>
                        <option value="descripcion">Descripción (A-Z)</option>
                        <option value="tipo_documento">Tipo documento (A-Z)</option>
                        <option value="numero_documento">N° documento (A-Z)</option>
                        <option value="tipo">Tipo (A-Z)</option>
                        <option value="verificado">Verificado (A-Z)</option>
                        <option value="comentarios">Comentarios (A-Z)</option>
                        <option value="monto">Monto</option>
                        <option value="saldo">Saldo</option>
                        <option value="archivo_origen">Archivo origen (A-Z)</option>
                      </select>
                    </div>

                    <div>
                      <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Dirección</p>
                      <select className={selectClass} value={sortConfig.direction} onChange={(event) => setSortConfig((prev) => ({ ...prev, direction: event.target.value }))}>
                        <option value="desc">Mayor a menor / Z-A</option>
                        <option value="asc">Menor a mayor / A-Z</option>
                      </select>
                    </div>

                    <Button
                      className={ghostButtonToneClass}
                      type="button"
                      variant="ghost"
                      disabled={isDefaultSort}
                      onClick={() => setSortConfig(DEFAULT_SORT_CONFIG)}
                    >
                      Predeterminado
                    </Button>
                  </div>
                </div>

                <div className={`max-h-[620px] overflow-auto rounded-xl border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                  <table className="w-full min-w-[920px] text-left text-sm">
                    <thead className={`${isDark ? 'bg-slate-900 text-slate-300' : 'bg-slate-100 text-slate-700'} sticky top-0 z-10 shadow-sm`}>
                      <tr>
                        {visibleColumns.posicion && <th className="p-3">#</th>}
                        {visibleColumns.mes && <th className="p-3">Mes</th>}
                        {visibleColumns.fecha && <th className="p-3 font-semibold">Fecha</th>}
                        {visibleColumns.cuenta && <th className="p-3">Cuenta</th>}
                        {visibleColumns.categoria && <th className="p-3">Categoría</th>}
                        {visibleColumns.subcategoria && <th className="p-3">Subcategoría</th>}
                        {visibleColumns.proyecto && <th className="p-3">Proyecto</th>}
                        {visibleColumns.codigo_proyecto && <th className="p-3">Código proyecto</th>}
                        {visibleColumns.emisor_receptor && <th className="p-3">Emisor / Receptor</th>}
                        {visibleColumns.descripcion && <th className="p-3">Descripción</th>}
                        {visibleColumns.tipo_documento && <th className="p-3">Tipo documento</th>}
                        {visibleColumns.numero_documento && <th className="p-3">N° documento</th>}
                        {visibleColumns.tipo && <th className="p-3">Tipo</th>}
                        {visibleColumns.verificado && <th className="p-3">Verificado</th>}
                        {visibleColumns.comentarios && <th className="p-3">Comentarios</th>}
                        {visibleColumns.monto && <th className="p-3 text-right">Monto</th>}
                        {visibleColumns.saldo && <th className="p-3 text-right">Saldo</th>}
                        {visibleColumns.archivo_origen && <th className="p-3">Archivo origen</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleColumnKeys.length > 0 && sortedRecords.map((item, index) => (
                        <tr key={item.id} className={`border-t ${isDark ? 'border-slate-800/90 hover:bg-slate-900/70' : 'border-slate-200 hover:bg-blue-50/60'} ${index % 2 === 0 ? (isDark ? 'bg-slate-950/30' : 'bg-white') : (isDark ? 'bg-slate-900/35' : 'bg-slate-50/70')}`}>
                          {visibleColumns.posicion && <td className="p-3 font-medium tabular-nums">{((pagination.page - 1) * pagination.page_size) + index + 1}</td>}
                          {visibleColumns.mes && <td className="p-3">{item.mes}</td>}
                          {visibleColumns.fecha && <td className="p-3">{item.fecha}</td>}
                          {visibleColumns.cuenta && <td className="p-3">{item.cuenta || 'General'}</td>}
                          {visibleColumns.categoria && <td className="p-3">{item.categoria}</td>}
                          {visibleColumns.subcategoria && <td className="p-3">{item.subcategoria}</td>}
                          {visibleColumns.proyecto && <td className="p-3">{item.proyecto || 'Sin proyecto'}</td>}
                          {visibleColumns.codigo_proyecto && <td className="p-3">{item.codigo_proyecto || '-'}</td>}
                          {visibleColumns.emisor_receptor && <td className="p-3">{item.emisor_receptor || '-'}</td>}
                          {visibleColumns.descripcion && (
                            <td className="p-3">
                              <span className="block max-w-[360px] truncate" title={item.descripcion}>{item.descripcion}</span>
                            </td>
                          )}
                          {visibleColumns.tipo_documento && <td className="p-3">{item.tipo_documento || '-'}</td>}
                          {visibleColumns.numero_documento && <td className="p-3">{item.numero_documento || '-'}</td>}
                          {visibleColumns.tipo && (
                            <td className="p-3">
                              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${item.tipo === 'ingreso' ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200' : 'bg-rose-100 text-rose-700 ring-1 ring-rose-200'}`}>
                                {item.tipo}
                              </span>
                            </td>
                          )}
                          {visibleColumns.verificado && <td className="p-3">{item.verificado || '-'}</td>}
                          {visibleColumns.comentarios && <td className="p-3">{item.comentarios || '-'}</td>}
                          {visibleColumns.monto && <td className={`p-3 text-right font-semibold tabular-nums ${item.tipo === 'ingreso' ? 'text-emerald-500' : 'text-rose-500'}`}>{currency(item.monto)}</td>}
                          {visibleColumns.saldo && <td className="p-3 text-right font-medium tabular-nums text-blue-500">{currency(item.saldo)}</td>}
                          {visibleColumns.archivo_origen && <td className="p-3">{item.archivo_origen || '-'}</td>}
                        </tr>
                      ))}
                      {sortedRecords.length === 0 && (
                        <tr>
                          <td className={`p-5 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`} colSpan={Math.max(visibleColumnKeys.length, 1)}>No hay datos para los filtros seleccionados.</td>
                        </tr>
                      )}
                      {visibleColumnKeys.length === 0 && (
                        <tr>
                          <td className={`p-5 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`} colSpan={1}>Selecciona al menos un campo visible para mostrar la tabla.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className={isDark ? 'text-sm text-slate-400' : 'text-sm text-slate-600'}>
                    Mostrando página {pagination.page} de {pagination.total_pages} · {pagination.total} registros
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <select className={selectClass} value={String(pagination.page_size)} onChange={async (event) => {
                      const nextSize = Number(event.target.value)
                      if (!Number.isNaN(nextSize) && nextSize > 0) {
                        await changePageSize(nextSize)
                      }
                    }}>
                      <option value="20">20 filas</option>
                      <option value="50">50 filas</option>
                      <option value="100">100 filas</option>
                      <option value="200">200 filas</option>
                      <option value="1000">Toda la data</option>
                    </select>
                    <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={exportFilteredRecordsCsv}><Download className="h-4 w-4" /> Exportar CSV</Button>
                    <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={() => changePage(pagination.page - 1)} disabled={pagination.page <= 1}><ChevronLeft className="h-4 w-4" /> Anterior</Button>
                    <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={() => changePage(pagination.page + 1)} disabled={pagination.page >= pagination.total_pages}>Siguiente <ChevronRight className="h-4 w-4" /></Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {activeTab === 'charts' && (
          <section className="mb-6 space-y-5">
            <Card className={cardToneClass}>
              <CardHeader>
                <CardTitle>Opciones de visualización</CardTitle>
                <CardDescription>Selecciona tipo de gráfico y filtro de flujo para analizar datos con foco. {currentPeriod}</CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <select className={selectClass} value={chartView} onChange={(event) => setChartView(event.target.value)}>
                  <option value="all">Mostrar todos los gráficos</option>
                  <option value="category">Monto por categoría</option>
                  <option value="flow">Distribución ingreso / egreso</option>
                  <option value="month">Tendencia mensual</option>
                </select>

                <select
                  className={selectClass}
                  value={filters.flowType}
                  onChange={async (event) => {
                    const value = event.target.value
                    await applyFlowFilter(value)
                  }}
                >
                  <option value="">Flujo: todos</option>
                  <option value="ingreso">Solo ingresos</option>
                  <option value="egreso">Solo egresos</option>
                </select>

                <Button
                  className={ghostButtonToneClass}
                  type="button"
                  variant="ghost"
                  onClick={() => setFullScreenChart(chartView === 'all' ? 'category' : chartView)}
                >
                  <Maximize2 className="h-4 w-4" /> Pantalla completa
                </Button>

                <Button
                  className={ghostButtonToneClass}
                  type="button"
                  variant="ghost"
                  onClick={clearChartFilters}
                >
                  Limpiar filtros de gráfico
                </Button>
              </CardContent>
            </Card>

            {(chartView === 'all' || chartView === 'category') && (
              <Card className={`${cardToneClass} overflow-hidden`}>
                <CardHeader>
                  <CardTitle>Monto por categoría</CardTitle>
                  <CardDescription>Suma de movimientos por categoría (CLP).</CardDescription>
                </CardHeader>
                <CardContent ref={categoryChartRef} className={chartView === 'category' ? 'h-[420px]' : 'h-[270px]'}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={summary.by_category} margin={{ top: 8, right: 12, left: 20, bottom: 8 }} onClick={(state) => {
                      const categoryLabel = state?.activeLabel
                      if (categoryLabel) {
                        applyCategoryFilter(categoryLabel)
                      }
                    }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1f2d47' : '#d8e1ef'} />
                      <XAxis dataKey="label" stroke={isDark ? '#94a3b8' : '#475569'} />
                      <YAxis width={80} stroke={isDark ? '#94a3b8' : '#475569'} tickFormatter={(value) => compactCurrency(value)} />
                      <Tooltip formatter={(value) => currency(value)} />
                      <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                        {summary.by_category.map((entry, index) => <Cell key={`${entry.label}-${index}`} fill={palette[index % palette.length]} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {(chartView === 'all' || chartView === 'flow') && (
              <Card className={`${cardToneClass} overflow-hidden`}>
                <CardHeader>
                  <CardTitle>Distribución ingreso / egreso</CardTitle>
                  <CardDescription>Participación porcentual del total según tipo de flujo.</CardDescription>
                </CardHeader>
                <CardContent ref={flowChartRef} className={chartView === 'flow' ? 'h-[420px]' : 'h-[270px]'}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={summary.by_flow}
                        dataKey="value"
                        nameKey="label"
                        innerRadius={65}
                        outerRadius={100}
                        paddingAngle={4}
                        onClick={(entry) => {
                          const flowLabel = entry?.label
                          if (flowLabel === 'ingreso' || flowLabel === 'egreso') {
                            applyFlowFilter(flowLabel)
                          }
                        }}
                      >
                        {summary.by_flow.map((entry, index) => {
                          const flowColor = entry.label === 'ingreso' ? '#10b981' : entry.label === 'egreso' ? '#f43f5e' : palette[index % palette.length]
                          return <Cell key={`${entry.label}-${index}`} fill={flowColor} />
                        })}
                      </Pie>
                      <Tooltip formatter={(value) => currency(value)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {(chartView === 'all' || chartView === 'month') && (
              <Card className={`${cardToneClass} overflow-hidden`}>
                <CardHeader>
                  <CardTitle>Tendencia mensual</CardTitle>
                  <CardDescription>Evolución del monto total por mes.</CardDescription>
                </CardHeader>
                <CardContent ref={monthChartRef} className={chartView === 'month' ? 'h-[420px]' : 'h-[270px]'}>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={summary.by_month}
                      margin={{ top: 8, right: 12, left: 20, bottom: 8 }}
                      onClick={(state) => {
                        const monthLabel = state?.activeLabel
                        if (monthLabel) {
                          applyMonthFilter(monthLabel)
                        }
                      }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1f2d47' : '#d8e1ef'} />
                      <XAxis dataKey="label" stroke={isDark ? '#94a3b8' : '#475569'} />
                      <YAxis width={80} stroke={isDark ? '#94a3b8' : '#475569'} tickFormatter={(value) => compactCurrency(value)} />
                      <Tooltip formatter={(value) => currency(value)} />
                      <Line type="monotone" dataKey="value" stroke="#60a5fa" strokeWidth={3} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </section>
        )}

        {activeTab === 'report' && (
          <section className="mb-6">
            <Card className={cardToneClass}>
              <CardHeader>
                <CardTitle>Informe detallado</CardTitle>
                <CardDescription>Resumen ejecutivo con métricas clave, categorías e insights automáticos. {currentPeriod}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className={`mb-4 rounded-xl border px-3 py-2 text-sm ${isDark ? 'border-slate-700 bg-slate-900/60 text-slate-300' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                  El balance corresponde a ingresos menos egresos del periodo filtrado. Los “Top categorías” muestran mayor monto acumulado.
                </div>
                <div className={`mb-4 rounded-xl border px-3 py-2 text-sm ${isDark ? 'border-blue-900/60 bg-blue-950/20 text-blue-200' : 'border-blue-200 bg-blue-50 text-blue-700'}`}>
                  Filtro activo del informe: {currentPeriod} · Flujo: {filters.flowType || 'todos'} · Categoría: {filters.category || 'todas'}
                </div>
                <div className="mb-4 flex justify-end">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={exportReportCsv}><Download className="h-4 w-4" /> CSV</Button>
                    <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={exportReportPdf}><Download className="h-4 w-4" /> PDF</Button>
                  </div>
                </div>

                <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Balance</p>
                    <p className="mt-2 text-lg font-semibold text-blue-500">{currency(report.totals.balance)}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Ingresos</p>
                    <p className="mt-2 text-lg font-semibold text-emerald-500">{currency(report.totals.income)}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Egresos</p>
                    <p className="mt-2 text-lg font-semibold text-rose-500">{currency(report.totals.expense)}</p>
                  </div>
                  <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-slate-50'}`}>
                    <p className={`text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Registros</p>
                    <p className="mt-2 text-lg font-semibold">{report.totals.records || 0}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-white'}`}>
                    <p className={`mb-3 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Top categorías</p>
                    <ul className="space-y-2 text-sm">
                      {(report.top_categories || []).map((item) => (
                        <li key={item.label} className={`flex items-center justify-between rounded-lg px-2 py-1.5 ${isDark ? 'hover:bg-slate-800/60' : 'hover:bg-slate-100/60'}`}>
                          <span>{item.label}</span>
                          <span className="font-semibold">{currency(item.value)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-white'}`}>
                    <p className={`mb-3 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Insights</p>
                    <ul className="space-y-2 text-sm">
                      {(report.insights || []).map((insight) => (
                        <li key={insight} className={`rounded-lg border px-3 py-2 ${isDark ? 'border-slate-700 bg-slate-950/60' : 'border-slate-200 bg-slate-50'}`}>
                          {insight}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-white'}`}>
                    <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Comparación mes actual vs anterior</p>
                    {monthComparison ? (
                      <div className="space-y-1 text-sm">
                        <p>Mes actual ({monthComparison.current.label}): <span className="font-semibold">{currency(monthComparison.current.value)}</span></p>
                        <p>Mes anterior ({monthComparison.previous.label}): <span className="font-semibold">{currency(monthComparison.previous.value)}</span></p>
                        <p>
                          Variación: <span className={`font-semibold ${monthComparison.delta >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>{currency(monthComparison.delta)} ({monthComparison.deltaPct.toFixed(1)}%)</span>
                        </p>
                      </div>
                    ) : (
                      <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>No hay suficientes meses para comparar.</p>
                    )}
                  </div>

                  <div className={`rounded-xl border p-4 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-white'}`}>
                    <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Comparación por rango de meses</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <select className={selectClass} value={compareFrom} onChange={(event) => setCompareFrom(event.target.value)}>
                        <option value="">Mes inicio</option>
                        {(summary.by_month || []).map((item) => <option key={`from-${item.label}`} value={item.label}>{item.label}</option>)}
                      </select>
                      <select className={selectClass} value={compareTo} onChange={(event) => setCompareTo(event.target.value)}>
                        <option value="">Mes fin</option>
                        {(summary.by_month || []).map((item) => <option key={`to-${item.label}`} value={item.label}>{item.label}</option>)}
                      </select>
                    </div>
                    {rangeComparison ? (
                      <div className="mt-2 space-y-1 text-sm">
                        <p>Rango: <span className="font-semibold">{rangeComparison.start} a {rangeComparison.end}</span></p>
                        <p>Meses incluidos: <span className="font-semibold">{rangeComparison.months}</span></p>
                        <p>Total acumulado: <span className="font-semibold text-blue-500">{currency(rangeComparison.total)}</span></p>
                      </div>
                    ) : (
                      <p className={`mt-2 text-sm ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Selecciona inicio y fin para comparar un rango.</p>
                    )}
                  </div>
                </div>

                <div className={`mt-4 rounded-xl border p-4 ${isDark ? 'border-slate-800 bg-slate-900/70' : 'border-slate-200 bg-white'}`}>
                  <p className={`mb-2 text-xs uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>Detalle de movimientos filtrados</p>
                  <div className={`max-h-[360px] overflow-auto rounded-lg border ${isDark ? 'border-slate-800' : 'border-slate-200'}`}>
                    <table className="w-full min-w-[880px] text-left text-sm">
                      <thead className={`${isDark ? 'bg-slate-900 text-slate-300' : 'bg-slate-100 text-slate-700'} sticky top-0`}>
                        <tr>
                          <th className="p-2">Mes</th>
                          <th className="p-2">Fecha</th>
                          <th className="p-2">Categoría</th>
                          <th className="p-2">Subcategoría</th>
                          <th className="p-2">Tipo</th>
                          <th className="p-2 text-right">Monto</th>
                          <th className="p-2">Descripción</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reportRows.slice(0, 80).map((item) => (
                          <tr key={`report-row-${item.id}`} className={`border-t ${isDark ? 'border-slate-800/90' : 'border-slate-200'}`}>
                            <td className="p-2">{item.mes}</td>
                            <td className="p-2">{item.fecha}</td>
                            <td className="p-2">{item.categoria}</td>
                            <td className="p-2">{item.subcategoria}</td>
                            <td className="p-2">{item.tipo}</td>
                            <td className={`p-2 text-right font-medium ${item.tipo === 'ingreso' ? 'text-emerald-500' : 'text-rose-500'}`}>{currency(item.monto)}</td>
                            <td className="p-2 max-w-[280px] truncate" title={item.descripcion}>{item.descripcion}</td>
                          </tr>
                        ))}
                        {reportRows.length === 0 && (
                          <tr>
                            <td className={`p-4 text-center ${isDark ? 'text-slate-400' : 'text-slate-500'}`} colSpan={7}>No hay movimientos para los filtros activos.</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </CardContent>
            </Card>
          </section>
        )}

        {fullScreenChart ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4" onClick={() => setFullScreenChart(null)}>
            <div
              className={`h-[90vh] w-full max-w-6xl rounded-2xl border p-4 ${isDark ? 'border-slate-700 bg-slate-950 text-slate-100' : 'border-slate-200 bg-white text-slate-900'}`}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-lg font-semibold">
                  {fullScreenChart === 'category' ? 'Monto por categoría' : fullScreenChart === 'flow' ? 'Distribución ingreso / egreso' : 'Tendencia mensual'}
                </h3>
                <Button className={ghostButtonToneClass} type="button" variant="ghost" onClick={() => setFullScreenChart(null)}>
                  <X className="h-4 w-4" /> Cerrar
                </Button>
              </div>

              <div className="h-[calc(90vh-90px)]">
                <ResponsiveContainer width="100%" height="100%">
                  {fullScreenChart === 'category' ? (
                    <BarChart data={summary.by_category} margin={{ top: 8, right: 12, left: 20, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1f2d47' : '#d8e1ef'} />
                      <XAxis dataKey="label" stroke={isDark ? '#94a3b8' : '#475569'} />
                      <YAxis width={80} stroke={isDark ? '#94a3b8' : '#475569'} tickFormatter={(value) => compactCurrency(value)} />
                      <Tooltip formatter={(value) => currency(value)} />
                      <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                        {summary.by_category.map((entry, index) => <Cell key={`${entry.label}-fullscreen-${index}`} fill={palette[index % palette.length]} />)}
                      </Bar>
                    </BarChart>
                  ) : fullScreenChart === 'flow' ? (
                    <PieChart>
                      <Pie data={summary.by_flow} dataKey="value" nameKey="label" innerRadius={95} outerRadius={160} paddingAngle={4}>
                        {summary.by_flow.map((entry, index) => {
                          const flowColor = entry.label === 'ingreso' ? '#10b981' : entry.label === 'egreso' ? '#f43f5e' : palette[index % palette.length]
                          return <Cell key={`${entry.label}-fullscreen-${index}`} fill={flowColor} />
                        })}
                      </Pie>
                      <Tooltip formatter={(value) => currency(value)} />
                      <Legend />
                    </PieChart>
                  ) : (
                    <LineChart data={summary.by_month} margin={{ top: 8, right: 12, left: 20, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#1f2d47' : '#d8e1ef'} />
                      <XAxis dataKey="label" stroke={isDark ? '#94a3b8' : '#475569'} />
                      <YAxis width={80} stroke={isDark ? '#94a3b8' : '#475569'} tickFormatter={(value) => compactCurrency(value)} />
                      <Tooltip formatter={(value) => currency(value)} />
                      <Line type="monotone" dataKey="value" stroke="#60a5fa" strokeWidth={3} dot={{ r: 4 }} />
                    </LineChart>
                  )}
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export default App
