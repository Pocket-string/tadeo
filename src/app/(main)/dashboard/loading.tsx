export default function DashboardLoading() {
  return (
    <div className="p-4 md:p-6 lg:p-8 space-y-6 animate-pulse">
      {/* Header */}
      <div>
        <div className="h-7 bg-neutral-200 rounded w-48" />
        <div className="h-4 bg-neutral-100 rounded w-64 mt-2" />
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-surface border border-border rounded-lg p-4">
            <div className="h-4 bg-neutral-100 rounded w-16 mb-2" />
            <div className="h-8 bg-neutral-200 rounded w-12 mb-1" />
            <div className="h-3 bg-neutral-100 rounded w-24" />
          </div>
        ))}
      </div>

      {/* Market Data table */}
      <div className="bg-surface border border-border rounded-lg p-6">
        <div className="h-5 bg-neutral-200 rounded w-36 mb-4" />
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex justify-between">
              <div className="h-4 bg-neutral-100 rounded w-24" />
              <div className="h-4 bg-neutral-100 rounded w-16" />
              <div className="h-4 bg-neutral-100 rounded w-12" />
              <div className="h-4 bg-neutral-100 rounded w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
