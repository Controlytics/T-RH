import useSWR from 'swr';

interface FieldConfig {
  id: string;
  fieldId: string;
  defaultName: string;
  displayName: string;
  module: string;
  description?: string;
}

// Default field labels (fallback)
const defaultLabels: Record<string, string> = {
  // User Management
  'FLD_USER_001': 'User ID',
  'FLD_USER_002': 'Full Name',
  'FLD_USER_003': 'Email',
  'FLD_USER_004': 'Department',
  'FLD_USER_005': 'Role',
  'FLD_USER_006': 'Status',
  // Entity Management
  'FLD_ASSET_001': 'Building Name',
  'FLD_ASSET_002': 'Block Name',
  'FLD_ASSET_003': 'Area Name',
  'FLD_ASSET_004': 'Device Name',
  'FLD_ASSET_005': 'Serial Number',
  // Attributes
  'FLD_ATTR_001': 'Attribute Name',
  // Telemetry
  'FLD_TELE_001': 'Telemetry Name',
};

export function useFieldLabels() {
  const { data, error, isLoading, mutate } = useSWR<FieldConfig[]>('/api/config/field-ids', {
    revalidateOnFocus: false,
    revalidateOnMount: true, dedupingInterval: 5000, // Cache for 5 minutes
  });

  // Build a lookup map from fieldId to displayName
  const labels: Record<string, string> = { ...defaultLabels };

  if (data && Array.isArray(data)) {
    data.forEach((field) => {
      labels[field.fieldId] = field.displayName;
    });
  }

  // Helper function to get a label by field ID
  const getLabel = (fieldId: string): string => {
    return labels[fieldId] || fieldId;
  };

  // Common field accessors for convenience
  const userLabels = {
    userId: labels['FLD_USER_001'] || 'User ID',
    fullName: labels['FLD_USER_002'] || 'Full Name',
    email: labels['FLD_USER_003'] || 'Email',
    department: labels['FLD_USER_004'] || 'Department',
    role: labels['FLD_USER_005'] || 'Role',
    status: labels['FLD_USER_006'] || 'Status',
  };

  const assetLabels = {
    buildingName: labels['FLD_ASSET_001'] || 'Building Name',
    blockName: labels['FLD_ASSET_002'] || 'Block Name',
    areaName: labels['FLD_ASSET_003'] || 'Area Name',
    deviceName: labels['FLD_ASSET_004'] || 'Device Name',
    serialNumber: labels['FLD_ASSET_005'] || 'Serial Number',
  };

  const attributeLabels = {
    attributeName: labels['FLD_ATTR_001'] || 'Attribute Name',
  };

  const telemetryLabels = {
    telemetryName: labels['FLD_TELE_001'] || 'Telemetry Name',
  };

  return {
    labels,
    getLabel,
    userLabels,
    assetLabels,
    attributeLabels,
    telemetryLabels,
    isLoading,
    error,
    mutate,
  };
}
