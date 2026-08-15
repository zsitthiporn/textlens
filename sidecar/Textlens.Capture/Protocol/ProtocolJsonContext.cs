using System.Text.Json.Serialization;

namespace Textlens.Capture.Protocol;

/// <summary>
/// The single place camelCase is configured on the C# side, and the single reason the
/// protocol works at all under NativeAOT: source-generated metadata means no
/// reflection-based serializer, which the published sidecar does not have.
///
/// Its counterpart in TypeScript needs no naming policy — property names there *are*
/// the wire names. That asymmetry is why every one of these types is covered by a
/// golden-fixture test: the two sides agree by verification, not by construction.
/// </summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ReadyEvent))]
[JsonSerializable(typeof(FrameEvent))]
[JsonSerializable(typeof(NoChangeEvent))]
[JsonSerializable(typeof(AckEvent))]
[JsonSerializable(typeof(ErrorEvent))]
[JsonSerializable(typeof(ListMonitorsCommand))]
[JsonSerializable(typeof(ConfigureCommand))]
[JsonSerializable(typeof(StartCommand))]
[JsonSerializable(typeof(StopCommand))]
[JsonSerializable(typeof(SnapshotCommand))]
[JsonSerializable(typeof(DebugFrameCommand))]
public sealed partial class ProtocolJsonContext : JsonSerializerContext
{
}
