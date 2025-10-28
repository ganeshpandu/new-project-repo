import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
  IsInt,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateUserListIntegrationInputDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  integrationId: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  status: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  connectedAt?: string;
}

export class CreateUserListDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  listId: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customName?: string;

  @ApiPropertyOptional({ type: [CreateUserListIntegrationInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateUserListIntegrationInputDto)
  integrations?: CreateUserListIntegrationInputDto[];
}

export class UpdateUserListDto extends PartialType(CreateUserListDto) {}

export class UserListFilterDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  listId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  pageNumber?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}
