import { PageHeader } from '@/components/ui/page-header'
import { PlayCircle } from 'lucide-react'

const VIDEOS = [
  {
    title: 'Visão geral + análise',
    description: 'O SAC real em operação, da visão geral do atendimento à análise do período.',
    src: '/videos/sac-visao-geral-analise-real.mp4',
  },
  {
    title: 'API oficial do WhatsApp',
    description: 'A operação real da API oficial e seus endpoints no painel autenticado.',
    src: '/videos/sac-api-oficial-whatsapp-real.mp4',
  },
  {
    title: 'Instagram',
    description: 'A automação real de comentários e Direct funcionando dentro do SAC.',
    src: '/videos/sac-instagram-real.mp4',
  },
  {
    title: 'Sistema e canais de vendas',
    description: 'Os canais reais do sistema e os indicadores de atendimento e disparo.',
    src: '/videos/sac-sistema-canais-vendas-real.mp4',
  },
] as const

export default function AprendaAUsarPage() {
  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <PageHeader
        icon={<PlayCircle size={22} />}
        title="Aprenda a Usar"
        description="Veja o SAC real funcionando nos quatro fluxos principais da operação."
      />

      <div className="grid gap-[var(--space-gutter)] md:grid-cols-2">
        {VIDEOS.map((video) => (
          <article key={video.src} className="card overflow-hidden">
            <div className="space-y-1 p-5 pb-3">
              <h2 className="text-h3 font-semibold text-fg">{video.title}</h2>
              <p className="text-body text-fg-muted">{video.description}</p>
            </div>
            <video
              className="block aspect-video w-full bg-black object-contain"
              controls
              playsInline
              preload="metadata"
              aria-label={video.title}
            >
              <source src={video.src} type="video/mp4" />
              Seu navegador não suporta a reprodução de vídeo.
            </video>
          </article>
        ))}
      </div>
    </div>
  )
}
